/**
 * Compute-policy harness wiring — the pure leaf (branch cp/harness, Module B):
 * injector wait rule, checker-spawn rule, progress keys + table, check_state
 * mapping, next-rung selection, chips, budget refusal, kill switches.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { blockingCheckerGateMs, GUEST_CHECKER_GATE_MS, finalizeDraftWaitMs } from './compute-policy-wiring';
import { messageSpentUsd, stampEscalation, nextRungForMessage as nextRungForMessageRow, shadowMachineAct, computePolicyMachineActEnabled, compactDecisionStash as compactStash, COMPACT_STASH_MAX_CHALLENGERS } from './compute-policy-wiring';
import {
  answerFirstDisabled, digDeeperDisabled, depthBudgetDisabled, uxBeaconDisabled, PROGRESS_KEYS, PROGRESS_LINES, keyedProgress, isProgressKey,
  checkStateForLateOutcome, injectorWaitMs, shouldSpawnChecker,
  nextRungForMessage, nextRungForPlan, depthChipFor, escalationPlan, escalationUserNote,
  depthMetadataFor, ETA_TEXT, RESEARCH_ETA_TEXT_CLOCKED, DEEPER_FINDINGS_KIND,
  parallelCrossCheckNote, PARALLEL_CROSS_CHECK_NOTE_BLOCKING, PARALLEL_CROSS_CHECK_NOTE_ANSWER_FIRST, PLAN_LABEL_ATTACH_MS,
  computePolicyMachineDisabled, machinePresetPlan, applyMachineRails, machineGateSpawnsChecker,
  computePolicyEnforcementStamp,
  researchRungBudgetDisabled, researchRungDeadlineMs, RESEARCH_RUNG_DEADLINE_FLOOR_MS,
  compactDecisionStash,
} from './compute-policy-wiring';
import { depthBudgetFor } from '../platform/depth-budget';
import type { DepthPlan } from '../platform/compute-policy-gate';

const plan = (over: Partial<DepthPlan> = {}): DepthPlan => ({
  preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high', council: 'none', reason: 'preset', source: 'preset', mode: 'off', ...over,
});

describe('kill switches (default OFF; 1/true/on arm them)', () => {
  it.each([
    ['ANSWER_FIRST_DISABLED', answerFirstDisabled],
    ['DIG_DEEPER_DISABLED', digDeeperDisabled],
    ['DEPTH_BUDGET_DISABLED', depthBudgetDisabled],
    ['UX_BEACON_DISABLED', uxBeaconDisabled],
  ])('%s', (name, fn) => {
    expect(fn({})).toBe(false);
    expect(fn({ [name]: '0' })).toBe(false);
    expect(fn({ [name]: '1' })).toBe(true);
    expect(fn({ [name]: 'true' })).toBe(true);
    expect(fn({ [name]: 'on' })).toBe(true);
  });
});

describe('progress keys — a FIXED set with server-side text (never model prose)', () => {
  it('the six keys and their lines', () => {
    expect([...PROGRESS_KEYS]).toEqual(['planning', 'checking_web', 'second_opinion', 'double_checking_stakes', 'deeper_findings_started', 'deeper_findings_ready']);
    for (const k of PROGRESS_KEYS) expect(PROGRESS_LINES[k].length).toBeGreaterThan(5);
    expect(isProgressKey('second_opinion')).toBe(true);
    expect(isProgressKey('model_prose')).toBe(false);
    // review 2026-09-26 M8: the agent's budget FINAL-TURN progress rides stage
    // 'deadline' with NO key (agent-budget-final-turn.test.ts pins the event) —
    // 'budget' is deliberately NOT in the client's fixed lookup set.
    expect(isProgressKey('budget')).toBe(false);
  });
  it('keyedProgress carries key + the table text + a stage; extras ride along', () => {
    const p = keyedProgress('double_checking_stakes', { waitMs: 90_000 });
    expect(p).toMatchObject({ key: 'double_checking_stakes', message: PROGRESS_LINES.double_checking_stakes, stage: 'query', waitMs: 90_000 });
    expect(keyedProgress('deeper_findings_started').stage).toBe('synthesis');
    expect(keyedProgress('checking_web').stage).toBe('model-searching');
  });
});

describe('check_state from a late-crosscheck outcome', () => {
  it('revised/addendum → updated with changed[]; unchanged → checked; everything else → interrupted', () => {
    expect(checkStateForLateOutcome('revised', ['number: 3'])).toEqual({ state: 'updated', changed: ['number: 3'] });
    expect(checkStateForLateOutcome('addendum', ['date: 2026'])).toEqual({ state: 'updated', changed: ['date: 2026'] });
    expect(checkStateForLateOutcome('unchanged')).toEqual({ state: 'checked' });
    for (const o of ['no_draft', 'timeout', 'reconcile_failed', 'interrupted'] as const) expect(checkStateForLateOutcome(o)).toEqual({ state: 'interrupted' });
  });
  it('conversation_moved (review M7): checked ONLY when a reconcile ran and found nothing material; otherwise interrupted — never a false "Checked ✓"', () => {
    expect(checkStateForLateOutcome('conversation_moved', [], { movedCheckCompleted: true })).toEqual({ state: 'checked' });
    expect(checkStateForLateOutcome('conversation_moved')).toEqual({ state: 'interrupted' });
    expect(checkStateForLateOutcome('conversation_moved', [], {})).toEqual({ state: 'interrupted' });
    expect(checkStateForLateOutcome('conversation_moved', [], { movedCheckCompleted: false })).toEqual({ state: 'interrupted' });
  });
});

describe('the lead\'s [PARALLEL CROSS-CHECK] doctrine paragraph (review H2)', () => {
  it('answer-first: never wait, never "answer now" — reconcile only a draft injected before you finish', () => {
    const note = parallelCrossCheckNote({ answerFirst: true });
    expect(note).toBe(PARALLEL_CROSS_CHECK_NOTE_ANSWER_FIRST);
    expect(note).toContain('[PARALLEL CROSS-CHECK IN PROGRESS]'); // doctrine-ordering pins read the header
    expect(note).toContain('Do NOT wait for it');
    expect(note).toContain('If its draft is injected');
    expect(note).not.toContain('do NOT write your final answer before the draft arrives');
    expect(note).not.toMatch(/EXCEPTION: if a system message/);
    expect(note).not.toMatch(/answer now/i);
  });
  it('kill switch / guest: today\'s blocking paragraph byte-for-byte (wait for the draft; the EXCEPTION note releases it)', () => {
    const note = parallelCrossCheckNote({ answerFirst: false });
    expect(note).toBe(PARALLEL_CROSS_CHECK_NOTE_BLOCKING);
    expect(note).toContain('[PARALLEL CROSS-CHECK IN PROGRESS]');
    expect(note).toContain('do NOT write your final answer before the draft arrives and you have reconciled with it');
    expect(note).toContain('EXCEPTION: if a system message tells you the Double Checker is STILL researching past its window');
  });
  it('the finalize label-attach cap is short (review M4: a shadow ask never sits on the request path)', () => {
    expect(PLAN_LABEL_ATTACH_MS).toBe(500);
  });
});

describe('blockingCheckerGateMs — guests are bounded at 75 s (audit 2026-10-03)', () => {
  it('a run with no chat row (guest) blocks at most 75 s', () => {
    expect(GUEST_CHECKER_GATE_MS).toBe(75_000);
    expect(blockingCheckerGateMs({ hasChatRow: false, gateMs: 300_000 }, {} as NodeJS.ProcessEnv)).toBe(75_000);
    expect(blockingCheckerGateMs({ hasChatRow: false, gateMs: 60_000 }, {} as NodeJS.ProcessEnv)).toBe(60_000);
  });
  it('a persisted chat (the ANSWER_FIRST_DISABLED path) keeps the full gate byte-for-byte', () => {
    expect(blockingCheckerGateMs({ hasChatRow: true, gateMs: 300_000 }, {} as NodeJS.ProcessEnv)).toBe(300_000);
  });
  it('GUEST_CHECKER_GATE_BOUND_DISABLED=1 restores the 300 s guest wait', () => {
    expect(blockingCheckerGateMs({ hasChatRow: false, gateMs: 300_000 }, { GUEST_CHECKER_GATE_BOUND_DISABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(300_000);
  });
});

describe('finalizeDraftWaitMs — a step-0 answer still owes the stakes / verify wait (audit 2026-10-03)', () => {
  const env = {} as NodeJS.ProcessEnv;
  const base = { answerFirst: true, lateWaitMs: 10_000, stakesBoundMs: 90_000 };
  it('ordinary plan: the plain 10 s late-wait', () => {
    expect(finalizeDraftWaitMs({ ...base, plan: { checkerWaitMs: 0 }, injectorWaited: false }, env)).toBe(10_000);
  });
  it('stakes / verify plan whose injector never waited: the plan bound (≤ STAKES_WAIT_MS)', () => {
    expect(finalizeDraftWaitMs({ ...base, plan: { checkerWaitMs: 90_000 }, injectorWaited: false }, env)).toBe(90_000);
    expect(finalizeDraftWaitMs({ ...base, plan: { checkerWaitMs: 500_000 }, injectorWaited: false }, env)).toBe(90_000);
  });
  it('the injector already waited: no second wait', () => {
    expect(finalizeDraftWaitMs({ ...base, plan: { checkerWaitMs: 90_000 }, injectorWaited: true }, env)).toBe(10_000);
  });
  it('not answer-first (guest / kill switch): unchanged', () => {
    expect(finalizeDraftWaitMs({ ...base, answerFirst: false, plan: { checkerWaitMs: 90_000 }, injectorWaited: false }, env)).toBe(10_000);
  });
  it('STAKES_FINALIZE_WAIT_DISABLED=1 restores the 10 s late-wait', () => {
    expect(finalizeDraftWaitMs({ ...base, plan: { checkerWaitMs: 90_000 }, injectorWaited: false }, { STAKES_FINALIZE_WAIT_DISABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(10_000);
  });
});

describe('injectorWaitMs — answer-first 0, stakes ≤ STAKES_WAIT_MS, kill switch = today\'s gate byte-for-byte', () => {
  const GATE = 300_000; const STAKES = 90_000;
  it('answer-first: 0 for an ordinary plan regardless of elapsed time', () => {
    expect(injectorWaitMs({ answerFirst: true, plan: plan(), elapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(0);
    expect(injectorWaitMs({ answerFirst: true, plan: plan(), elapsedMs: 50_000, gateMs: GATE, stakesBoundMs: STAKES })).toBe(0);
  });
  it('answer-first stakes path: min(plan.checkerWaitMs, STAKES) minus the stakes clock (defaults to elapsedMs), never above the owner bound', () => {
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(90_000);
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 30_000, gateMs: GATE, stakesBoundMs: STAKES })).toBe(60_000);
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 300_000 }), elapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(90_000);
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 120_000, gateMs: GATE, stakesBoundMs: STAKES })).toBe(0);
  });
  it('the stakes clock starts at the injector\'s FIRST call (review M5): a long step 0 (elapsedMs > the bound) no longer degrades the wait to 0', () => {
    // step 0 took 200 s on a 'max' seat; the injector is only now getting its first opportunity
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 200_000, stakesElapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(90_000);
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 230_000, stakesElapsedMs: 30_000, gateMs: GATE, stakesBoundMs: STAKES })).toBe(60_000);
    expect(injectorWaitMs({ answerFirst: true, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 300_000, stakesElapsedMs: 95_000, gateMs: GATE, stakesBoundMs: STAKES })).toBe(0);
    // the stakes clock never touches the non-stakes (wait 0) or the kill-switch arithmetic
    expect(injectorWaitMs({ answerFirst: true, plan: plan(), elapsedMs: 200_000, stakesElapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(0);
    expect(injectorWaitMs({ answerFirst: false, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: 200_000, stakesElapsedMs: 0, gateMs: GATE, stakesBoundMs: STAKES })).toBe(100_000);
  });
  it('kill switch / guest (answerFirst false): CROSS_CHECK_GATE_MS − elapsed, floored at 0 — the pre-2026-09-26 arithmetic', () => {
    for (const elapsed of [0, 1_000, 123_456, 299_999, 300_000, 999_999]) {
      const today = Math.max(0, GATE - elapsed);
      expect(injectorWaitMs({ answerFirst: false, plan: plan({ checkerWaitMs: 90_000 }), elapsedMs: elapsed, gateMs: GATE, stakesBoundMs: STAKES })).toBe(today);
    }
  });
});

describe('shouldSpawnChecker — by PLAN, never by mode alone', () => {
  it('the L2 preset spawns; the L1 preset does not; the gate may flip either', () => {
    expect(shouldSpawnChecker({ plan: plan(), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false })).toBe(true);
    expect(shouldSpawnChecker({ plan: plan({ preset: 'single_thinking', spawnChecker: false }), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false })).toBe(false);
    expect(shouldSpawnChecker({ plan: plan({ preset: 'single_thinking', spawnChecker: true, source: 'gate_act' }), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false })).toBe(true);
    expect(shouldSpawnChecker({ plan: plan({ spawnChecker: false, source: 'gate_act' }), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false })).toBe(false);
  });
  it('machine turns, an unservable seat and the council never spawn', () => {
    expect(shouldSpawnChecker({ plan: plan(), machineTurnSkipsChecker: true, checkerSeatProblem: null, isCouncil: false })).toBe(false);
    expect(shouldSpawnChecker({ plan: plan(), machineTurnSkipsChecker: false, checkerSeatProblem: 'no key', isCouncil: false })).toBe(false);
    expect(shouldSpawnChecker({ plan: plan({ preset: 'deep_research' }), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: true })).toBe(false);
  });
});

describe('Dig deeper — next rung, chips, ETA', () => {
  it('nextRungForMessage: unchecked → verify; checked → research; council / research-escalated / deeper-findings → none', () => {
    expect(nextRungForMessage({ mode: 'single_thinking' })).toBe('verify');
    expect(nextRungForMessage({ mode: 'thinking' })).toBe('research');
    expect(nextRungForMessage({ mode: 'deep_research' })).toBeNull();
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false } } })).toBe('verify');
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: true, source: 'gate_act' } } })).toBe('research');
    expect(nextRungForMessage({ depth: { plan: { preset: 'thinking', spawnChecker: false, source: 'gate_act' } } })).toBe('verify');
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false }, escalations: [{ rung: 'verify', at: 'x' }] } })).toBe('research');
    expect(nextRungForMessage({ depth: { plan: { preset: 'thinking', spawnChecker: true }, escalations: [{ rung: 'research', at: 'x' }] } })).toBeNull();
    expect(nextRungForMessage({ kind: DEEPER_FINDINGS_KIND, mode: 'thinking' })).toBeNull();
    expect(nextRungForMessage(null)).toBe('verify');
  });
  it('nextRungForPlan mirrors it for the chip at finalize', () => {
    expect(nextRungForPlan(plan({ preset: 'single_thinking', spawnChecker: false }))).toBe('verify');
    expect(nextRungForPlan(plan())).toBe('research');
    expect(nextRungForPlan(plan({ preset: 'deep_research', spawnChecker: false }))).toBeNull();
    // Audit 2026-09-26 (routing-unify-3): a gate `council:'background'` is NOT a council that ran — the research chip stays.
    expect(nextRungForPlan(plan({ council: 'background' }))).toBe('research');
    expect(nextRungForPlan(plan({ preset: 'single_thinking', spawnChecker: false }), 'verify')).toBe('research');
    expect(nextRungForPlan(plan(), 'research')).toBeNull();
  });
  it('depthChipFor: escalate for signed-in, signin_deeper for guests, none on machine runs / disabled / no rung', () => {
    expect(depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: 'verify' })).toEqual({ kind: 'escalate', label: 'Dig deeper', escalationOf: 'm1', nextRung: 'verify', etaText: ETA_TEXT.verify });
    expect((depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: 'research' }) as any).etaText).toBe(ETA_TEXT.research);
    // RESEARCH_NO_WALL_CLOCK_DISABLED=1 puts the rung back on its clock — the chip must not promise "no limit" then
    process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1';
    try {
      expect((depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: 'research' }) as any).etaText).toBe(RESEARCH_ETA_TEXT_CLOCKED);
      expect((depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: 'verify' }) as any).etaText).toBe(ETA_TEXT.verify);
    } finally { delete process.env.RESEARCH_NO_WALL_CLOCK_DISABLED; }
    expect(depthChipFor({ guest: true, machine: false, messageId: null, nextRung: 'verify' })).toEqual({ kind: 'signin_deeper', label: 'Sign in for a deeper look' });
    expect(depthChipFor({ guest: false, machine: true, messageId: 'm1', nextRung: 'verify' })).toBeNull();
    expect(depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: 'verify', disabled: true })).toBeNull();
    expect(depthChipFor({ guest: false, machine: false, messageId: 'm1', nextRung: null })).toBeNull();
    expect(depthChipFor({ guest: false, machine: false, messageId: null, nextRung: 'verify' })).toBeNull();
  });
  it('the ETA text is harness-owned copy, never a number a model typed', () => {
    expect(ETA_TEXT.verify).toMatch(/minute/);
    // deep research has no wall clock (2026-10-20): the research rung promises no fixed time
    expect(ETA_TEXT.research).toMatch(/post it here when it.s ready/);
    expect(ETA_TEXT.research).not.toMatch(/\d|minute|hour/);
    // byte-identical to the client's RUNG_ETA_TEXT (frontend/lib/depth-ux.ts) — the reloaded chip must read like the live one
    expect(ETA_TEXT).toEqual({ verify: 'a couple of minutes', research: 'as long as it needs — I\u2019ll post it here when it\u2019s ready' });
  });
  const clientDepthUx = join(__dirname, '../../../../../frontend/lib/depth-ux.ts');
  (existsSync(clientDepthUx) ? it : it.skip)('the client RUNG_ETA_TEXT carries the SAME research copy byte-for-byte (repo checkout)', () => {
    const src = readFileSync(clientDepthUx, 'utf8');
    expect(src).toContain(`research: '${ETA_TEXT.research}',`);
    expect(src).toContain(`verify: '${ETA_TEXT.verify}',`);
  });
  it('escalationPlan: verify = L2 preset + stakes-bounded wait + max; research = council background; both source escalation', () => {
    expect(escalationPlan('verify', 90_000)).toMatchObject({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max', council: 'none', source: 'escalation' });
    expect(escalationPlan('research', 90_000)).toMatchObject({ preset: 'deep_research', spawnChecker: false, council: 'background', leadEffort: 'max', source: 'escalation' });
    expect(escalationUserNote('verify')).toMatch(/DIG DEEPER/);
    expect(escalationUserNote('research')).toMatch(/council/);
  });

  it('escalationUserNote: the research rung carries the ambition-map depth mandate; the verify rung stays a verification note (map A1, 2026-10-15)', () => {
    // docs/AMBITIOUS_PROMPTING_MAP_2026-10-15.md §2 A1 (tranche 2 of the §7 sequencing):
    // the research rung's harness note is the essay's depth moment — verify against
    // PRIMARY SOURCES and challenge ASSUMPTIONS, not just re-check facts. The verify
    // rung is deliberately untouched: it is the outside judge (Double Checker + live
    // evidence), and the map scopes the depth language to the research rung only.
    expect(escalationUserNote('research')).toContain('[DIG DEEPER — the user asked for a deeper look at your earlier answer to this question. Lead the research council on it now: verify the earlier answer\'s key claims against primary sources, challenge its underlying assumptions (not just its facts), correct what was wrong, add what was missing. Write "Deeper findings" as a complete stand-alone answer.]');
    // the verify rung keeps its re-verification shape — no assumptions mandate leaked into it
    expect(escalationUserNote('verify')).toContain('Re-verify its key claims with live evidence');
    expect(escalationUserNote('verify')).not.toMatch(/assumption/i);
  });
});

describe('DepthBudget — no spend rail (owner 2026-09-27: no hidden cost caps)', () => {
  it('REGRESSION PIN: the USD refusal helpers are GONE — budgetExceeded / budgetRefusalMessage / depthBudgetEnforcedFor are not exported, so nothing can refuse a rung on cost', async () => {
    const mod: any = await import('./compute-policy-wiring');
    expect(mod.budgetExceeded).toBeUndefined();
    expect(mod.budgetRefusalMessage).toBeUndefined();
    expect(mod.depthBudgetEnforcedFor).toBeUndefined();
  });
  it('depthMetadataFor persists the plan tuple, the budget (time bound only), the decision stash and the spend as a RECORD', () => {
    const m = depthMetadataFor(plan({ decisionId: 'd1', answers: { depth: { type: 'choice', choice: 'ordinary' } }, mode: 'shadow', source: 'gate_shadow' }), { checker: true, checkerEffort: 'high', council: false, maxBackgroundMs: 1 }, 0.07);
    expect(m).toMatchObject({ plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' }, budget: { maxBackgroundMs: 1 }, decisionId: 'd1', decision: { id: 'd1', mode: 'shadow' }, spentUsd: 0.07 });
    expect(m.budget).not.toHaveProperty('maxUsd');
    expect(m.budget).not.toHaveProperty('enforced');
    expect(depthMetadataFor(plan(), { checker: true, checkerEffort: 'high', council: false, maxBackgroundMs: 1 })).not.toHaveProperty('decisionId');
  });
  it('depthMetadataFor keeps the bare budget on every row — the `enforced` stamp died with the rail', () => {
    const budget = { checker: true, checkerEffort: 'high' as const, council: false, maxBackgroundMs: 1 };
    expect(depthMetadataFor(plan(), budget, 0.3, null).budget).toEqual(budget);
    expect(depthMetadataFor(plan(), budget, 99).budget).toEqual(budget); // heavy spend changes nothing
  });
  it('depthMetadataFor carries the H2 backgroundDeadlineHit fact when the harness stamps it (absent otherwise)', () => {
    const b = { checker: false, checkerEffort: 'high' as const, council: true, maxBackgroundMs: 900_000 };
    const facts = { leadToolCalls: 3, webToolCalls: 1, finalChars: 900, checkerSpawned: false, checkerMerged: false };
    expect(depthMetadataFor(escalationPlan('research', 90_000), b, 0.1, { ...facts, backgroundDeadlineHit: true }).facts).toMatchObject({ backgroundDeadlineHit: true });
    expect(depthMetadataFor(escalationPlan('research', 90_000), b, 0.1, facts).facts).not.toHaveProperty('backgroundDeadlineHit');
  });
});

describe('telemetry honesty — leadEffortSent (audit 2026-09-26 supervisors-auto-4; budgetEnforced DELETED 2026-09-27 with the USD rail)', () => {
  const env = {} as NodeJS.ProcessEnv;
  it('a human / supervisor / council row gets NO stamp (no rail exists to describe); no row ever carries budgetEnforced', () => {
    expect(computePolicyEnforcementStamp({ machine: false, supervisor: false, council: false, leadEffortSent: 'high' }, env)).toEqual({});
    expect(computePolicyEnforcementStamp({ machine: false, supervisor: true, council: false, leadEffortSent: 'high' }, env)).toEqual({});
    expect(computePolicyEnforcementStamp({ machine: false, supervisor: false, council: true, leadEffortSent: 'max' }, env)).toEqual({});
  });
  it('a machine row carries ONLY the effort the lead was actually sent (so a wake_effort act flip is visible on the same row)', () => {
    expect(computePolicyEnforcementStamp({ machine: true, supervisor: true, council: false, leadEffortSent: 'high' }, env)).toEqual({ leadEffortSent: 'high' });
    expect(computePolicyEnforcementStamp({ machine: true, supervisor: false, council: false, leadEffortSent: 'max' }, env)).toEqual({ leadEffortSent: 'max' });
  });
});

describe('machine rails (owner 2026-09-26: supervisor / machine wakes on the compute policy; presets are the fallback)', () => {
  const preset = (over: Partial<DepthPlan> = {}): DepthPlan => ({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high', council: 'none', reason: 'preset thinking', source: 'preset', mode: 'off', ...over });

  it('computePolicyMachineDisabled reads 1/true/on', () => {
    expect(computePolicyMachineDisabled({})).toBe(false);
    expect(computePolicyMachineDisabled({ COMPUTE_POLICY_MACHINE_DISABLED: '1' })).toBe(true);
    expect(computePolicyMachineDisabled({ COMPUTE_POLICY_MACHINE_DISABLED: 'on' })).toBe(true);
    expect(computePolicyMachineDisabled({ COMPUTE_POLICY_MACHINE_DISABLED: '0' })).toBe(false);
  });

  it("machinePresetPlan = what a machine wake ran by construction before: lead max, no checker, wait 0, no council, source 'preset'", () => {
    expect(machinePresetPlan('thinking')).toMatchObject({ preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max', council: 'none', source: 'preset', mode: 'off' });
    expect(machinePresetPlan('single_thinking').preset).toBe('single_thinking');
    expect(machinePresetPlan('deep_research').preset).toBe('deep_research'); // the inline council stays the preset's own business
    expect(machinePresetPlan('thinking', 'machine preset (gate error)').reason).toBe('machine preset (gate error)');
  });

  it('applyMachineRails: a shadow / preset plan loses its preset checker; an ACT plan keeps ONLY a gate-added checker — never a wait, never a council, lead max; ANSWER_FIRST_DISABLED refuses even the gate checker', () => {
    expect(applyMachineRails(preset({ source: 'gate_shadow', decisionId: 'd1', mode: 'shadow' }), { answerFirstOff: false })).toMatchObject({ spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max', council: 'none', decisionId: 'd1', source: 'gate_shadow' });
    const act = applyMachineRails(preset({ source: 'gate_act', mode: 'act', spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max', council: 'background', decisionId: 'd2' }), { answerFirstOff: false });
    expect(act).toMatchObject({ spawnChecker: true, checkerWaitMs: 0, leadEffort: 'max', council: 'none', source: 'gate_act', decisionId: 'd2' });
    expect(act.reason).toContain('machine rails');
    expect(applyMachineRails(preset({ source: 'gate_act', mode: 'act', spawnChecker: true }), { answerFirstOff: true }).spawnChecker).toBe(false);
    expect(applyMachineRails(preset({ source: 'gate_act', mode: 'act', spawnChecker: false, leadEffort: 'high' }), { answerFirstOff: false })).toMatchObject({ spawnChecker: false, leadEffort: 'max' });
  });

  it('machineGateSpawnsChecker: only a machine-triggered run with a post-rails gate_act plan that still spawns', () => {
    expect(machineGateSpawnsChecker({ source: 'gate_act', spawnChecker: true }, true)).toBe(true);
    expect(machineGateSpawnsChecker({ source: 'gate_act', spawnChecker: true }, false)).toBe(false);
    expect(machineGateSpawnsChecker({ source: 'preset', spawnChecker: true }, true)).toBe(false);
    expect(machineGateSpawnsChecker({ source: 'gate_shadow', spawnChecker: true }, true)).toBe(false);
    expect(machineGateSpawnsChecker({ source: 'gate_act', spawnChecker: false }, true)).toBe(false);
  });
});

describe('audit 2026-09-26 — rung ledger, per-message spend, machine act downgrade, compact stash', () => {
  it('messageSpentUsd sums the finalize spend and every rung spend (budgets-cost-1)', () => {
    expect(messageSpentUsd({ depth: { spentUsd: 0.07, escalations: [{ rung: 'verify', at: 't', status: 'done', spentUsd: 0.1 }, { rung: 'research', at: 't', status: 'done', spentUsd: 0.28 }] } })).toBeCloseTo(0.45, 6);
    expect(messageSpentUsd({ depth: { spentUsd: 0.07 } })).toBe(0.07);
    expect(messageSpentUsd({ depth: { escalations: [{ rung: 'verify', at: 't', spentUsd: 'x' }] } })).toBe(0);
    expect(messageSpentUsd(null)).toBe(0);
  });
  it('stampEscalation: running → done replaces the entry (spend rounded); interrupted replaces running; a done entry is never overwritten; legacy entries kept', () => {
    const running = stampEscalation([], { rung: 'verify', at: 't1', status: 'running' });
    expect(running).toEqual([{ rung: 'verify', at: 't1', status: 'running' }]);
    const done = stampEscalation(running, { rung: 'verify', at: 't2', status: 'done', messageId: 'm2', spentUsd: 0.123456 });
    expect(done).toEqual([{ rung: 'verify', at: 't2', status: 'done', messageId: 'm2', spentUsd: 0.1235 }]);
    const interrupted = stampEscalation([{ rung: 'research', at: 't3', status: 'running' }], { rung: 'research', at: 't4', status: 'interrupted' });
    expect(interrupted).toEqual([{ rung: 'research', at: 't4', status: 'interrupted' }]);
    const again = stampEscalation(done, { rung: 'verify', at: 't5', status: 'running' });
    expect(again).toHaveLength(2);
    expect(stampEscalation([{ rung: 'verify', at: 'legacy', messageId: 'x' }, null, 'junk'], { rung: 'research', at: 't', status: 'running' })).toHaveLength(2);
  });
  it('nextRungForMessage: a RUNNING rung refuses a re-tap; an interrupted rung is not spent (re-offered); an addendum row never escalates', () => {
    const depth = (escalations: any[]) => ({ depth: { plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'preset' }, escalations } });
    expect(nextRungForMessageRow(depth([{ rung: 'research', at: 't', status: 'running' }]))).toBeNull();
    expect(nextRungForMessageRow(depth([{ rung: 'research', at: 't', status: 'interrupted' }]))).toBe('research');
    expect(nextRungForMessageRow(depth([{ rung: 'research', at: 't', status: 'done' }]))).toBeNull();
    expect(nextRungForMessageRow(depth([{ rung: 'research', at: 't' }]))).toBeNull(); // legacy = done
    expect(nextRungForMessageRow({ kind: 'check_addendum', mode: 'thinking' })).toBeNull();
  });
  it('shadowMachineAct: a gate_act plan on a machine / supervisor turn becomes the fallback tuple with the decision identity (gate_shadow); other sources untouched; the env opts in', () => {
    const fallback = { preset: 'thinking' as const, spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max' as const, council: 'none' as const, reason: 'machine preset thinking', source: 'preset' as const, mode: 'off' as const };
    const act: DepthPlan = { ...fallback, spawnChecker: true, source: 'gate_act' as const, mode: 'act' as const, decisionId: 'd1', answers: { depth: { type: 'choice', choice: 'contestable' } }, stash: { id: 'd1' } as any, reason: 'decision gate: stakes' };
    expect(shadowMachineAct(act, fallback)).toMatchObject({ spawnChecker: false, source: 'gate_shadow', mode: 'shadow', decisionId: 'd1', stash: { id: 'd1' } });
    expect(shadowMachineAct(act, fallback).reason).toContain('downgraded to shadow');
    const shadow = { ...act, source: 'gate_shadow' as const };
    expect(shadowMachineAct(shadow, fallback)).toBe(shadow);
    expect(computePolicyMachineActEnabled({})).toBe(false);
    expect(computePolicyMachineActEnabled({ COMPUTE_POLICY_MACHINE_ACT_ENABLED: '1' })).toBe(true);
  });
  it('compactDecisionStash keeps the ok challengers (answers-only, bounded) so a persisted-row label emits the per-challenger row (telemetry-readiness-5)', () => {
    const challengers = Array.from({ length: COMPACT_STASH_MAX_CHALLENGERS + 2 }, (_, i) => ({ id: `c${i}`, spec: `spec${i}`, backend: `b${i}`, ok: true, ms: 5, answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6 } }, calibrated: true, usage: { in: 1 } }));
    const out = compactStash({ id: 'd', purpose: 'compute_policy', mode: 'shadow', backend: 'TypeSafe Jev', backendSpec: 'jev', stateHash: 'h', questionsHash: 'q', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6 } }, challengers })!;
    expect(out).toMatchObject({ id: 'd', backend: 'TypeSafe Jev', backendSpec: 'jev', stateHash: 'h', questionsHash: 'q' });
    expect((out.challengers as any[]).length).toBe(COMPACT_STASH_MAX_CHALLENGERS);
    expect((out.challengers as any[])[0]).toEqual({ id: 'c0', spec: 'spec0', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6 } }, backend: 'b0', calibrated: true });
    expect(compactStash({ id: 'd', answers: {}, challengers: [{ id: 'x' }] })).not.toHaveProperty('challengers');
  });
});
// ── audit H2 (2026-09-26): the research rung's wall-clock rail ──────────────
describe('researchRungDeadlineMs — maxBackgroundMs enforced through the council FINAL-TURN deadline', () => {
  const budget = { maxBackgroundMs: 15 * 60_000 };
  it('the lead (elapsed 0) gets the budget itself, never more than the backstop', () => {
    expect(researchRungDeadlineMs(40 * 60_000, budget, 0, false)).toBe(15 * 60_000);
    expect(researchRungDeadlineMs(10 * 60_000, budget, 0, false)).toBe(10 * 60_000); // a backstop below the budget stays the ceiling
  });
  it('a colleague / clone dispatched later gets what is LEFT of the budget, floored at 60 s', () => {
    expect(researchRungDeadlineMs(30 * 60_000, budget, 5 * 60_000, false)).toBe(10 * 60_000);
    expect(researchRungDeadlineMs(15 * 60_000, budget, 14.5 * 60_000, false)).toBe(RESEARCH_RUNG_DEADLINE_FLOOR_MS);
    expect(researchRungDeadlineMs(15 * 60_000, budget, 99 * 60_000, false)).toBe(RESEARCH_RUNG_DEADLINE_FLOOR_MS);
    expect(RESEARCH_RUNG_DEADLINE_FLOOR_MS).toBe(60_000);
  });
  it('fails open: disabled, a non-finite / non-positive budget or a garbage elapsed value ⇒ the backstop / the budget', () => {
    expect(researchRungDeadlineMs(40 * 60_000, budget, 0, true)).toBe(40 * 60_000);
    expect(researchRungDeadlineMs(40 * 60_000, { maxBackgroundMs: NaN }, 0, false)).toBe(40 * 60_000);
    expect(researchRungDeadlineMs(40 * 60_000, { maxBackgroundMs: 0 }, 0, false)).toBe(40 * 60_000);
    expect(researchRungDeadlineMs(40 * 60_000, budget, NaN, false)).toBe(15 * 60_000);
    expect(researchRungDeadlineMs(40 * 60_000, budget, -5_000, false)).toBe(15 * 60_000);
  });
  it('DEPTH_BUDGET_DISABLED=1 disables the research rung budget too (the umbrella)', () => {
    expect(researchRungBudgetDisabled({})).toBe(false);
    expect(researchRungBudgetDisabled({ DEPTH_BUDGET_DISABLED: '1' })).toBe(true);
    // the default argument reads process.env
    const prev = process.env.DEPTH_BUDGET_DISABLED;
    process.env.DEPTH_BUDGET_DISABLED = '1';
    try { expect(researchRungDeadlineMs(40 * 60_000, budget, 0)).toBe(40 * 60_000); }
    finally { if (prev === undefined) delete process.env.DEPTH_BUDGET_DISABLED; else process.env.DEPTH_BUDGET_DISABLED = prev; }
  });
});
describe('2026-09-26 (audit) — the compact persisted decision carries the segment', () => {
  const budget = { checker: true, checkerEffort: 'high' as const, council: false, maxBackgroundMs: 1 };
  it('depthMetadataFor persists metadata.depth.decision.segment when the plan has one (absent otherwise); compactDecisionStash keeps it and drops the challengers', () => {
    const answers = { depth: { type: 'choice', choice: 'ordinary' } };
    const m = depthMetadataFor(plan({ decisionId: 'd1', answers, mode: 'shadow', source: 'gate_shadow', segment: 'supervisor' }), budget);
    expect(m.decision).toEqual({ id: 'd1', answers, mode: 'shadow', segment: 'supervisor' });
    expect(depthMetadataFor(plan({ decisionId: 'd1', answers, mode: 'shadow', source: 'gate_shadow' }), budget).decision).not.toHaveProperty('segment');
    expect(compactDecisionStash({ id: 'r1', answers: { material: { type: 'noul', noul: 0.2 } }, purpose: 'revision_material', mode: 'shadow', segment: 'machine', challengers: [{}] }))
      .toEqual({ id: 'r1', answers: { material: { type: 'noul', noul: 0.2 } }, purpose: 'revision_material', mode: 'shadow', segment: 'machine' });
  });
});

describe('supervisor chats: no Double Checker (owner 2026-10-06)', () => {
  const { withoutSupervisorChecker, supervisorCheckerSkipDisabled } = require('./compute-policy-wiring');
  it('drops the checker and its wait from an L2-shaped plan', () => {
    const p = withoutSupervisorChecker({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 90000, leadEffort: 'max', council: 'none', reason: 'preset thinking', source: 'preset', mode: 'off' });
    expect(p.spawnChecker).toBe(false);
    expect(p.checkerWaitMs).toBe(0);
    expect(p.reason).toContain('supervisor chat: no Double Checker');
    expect(p.preset).toBe('thinking');
  });
  it('leaves a checker-less plan untouched', () => {
    const plan = { preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max', council: 'none', reason: 'r', source: 'preset', mode: 'off' };
    expect(withoutSupervisorChecker(plan)).toBe(plan);
  });
  it('kill switch SUPERVISOR_CHECKER_SKIP_DISABLED=1', () => {
    expect(supervisorCheckerSkipDisabled({} as any)).toBe(false);
    expect(supervisorCheckerSkipDisabled({ SUPERVISOR_CHECKER_SKIP_DISABLED: '1' } as any)).toBe(true);
  });
});

describe('roster 2026-10-06 A-4 — Dig-deeper rungs as LANE steps (quick / standard → checked → research)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const w = require('./compute-policy-wiring') as typeof import('./compute-policy-wiring');
  afterEach(() => { delete process.env.LANE_RUNGS_DISABLED; });
  it('planLane: the plan\'s own lane, else the preset alias; nextLaneRung climbs one lane', () => {
    expect(w.planLane({ preset: 'single_thinking', spawnChecker: false, lane: 'quick' })).toBe('quick');
    expect(w.planLane({ preset: 'single_thinking', spawnChecker: false })).toBe('standard');
    expect(w.planLane({ preset: 'thinking', spawnChecker: true })).toBe('checked');
    expect(w.planLane({ preset: 'deep_research', spawnChecker: false })).toBe('research');
    expect(w.planLane(null)).toBe('standard');
    expect(w.nextLaneRung('quick')).toBe('verify');
    expect(w.nextLaneRung('standard')).toBe('verify');
    expect(w.nextLaneRung('checked')).toBe('research');
    expect(w.nextLaneRung('research')).toBeNull();
  });
  it('a lane-governed row reads its LANE: standard ⇒ verify, checked ⇒ research, research ⇒ none; a spent verify moves a standard row to research', () => {
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'turn_plan' } } })).toBe('verify');
    expect(nextRungForMessage({ depth: { plan: { preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' } } })).toBe('research');
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'lane_fail_open' }, escalations: [{ rung: 'verify', at: 'x' }] } })).toBe('research');
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false, lane: 'quick' } } })).toBe('verify');
    expect(nextRungForPlan(plan({ preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'turn_plan' }))).toBe('verify');
    expect(nextRungForPlan(plan({ preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' }))).toBe('research');
    expect(nextRungForPlan(plan({ preset: 'deep_research', spawnChecker: false, lane: 'research' }))).toBeNull();
  });
  it('the rung plans record the lane they run (verify = checked, research = research); LANE_RUNGS_DISABLED=1 drops it and reads the preset again', () => {
    expect(escalationPlan('verify', 90_000).lane).toBe('checked');
    expect(escalationPlan('research', 90_000).lane).toBe('research');
    process.env.LANE_RUNGS_DISABLED = '1';
    expect(w.laneRungsDisabled()).toBe(true);
    expect(escalationPlan('verify', 90_000).lane).toBeUndefined();
    expect(nextRungForMessage({ mode: 'thinking' })).toBe('research');
    expect(nextRungForMessage({ depth: { plan: { preset: 'single_thinking', spawnChecker: false }, escalations: [{ rung: 'verify', at: 'x' }] } })).toBe('research');
    expect(nextRungForPlan(plan({ preset: 'single_thinking', spawnChecker: false }))).toBe('verify');
  });
  it('depthMetadataFor persists a lane-governed plan\'s lane + source', () => {
    const m = depthMetadataFor(plan({ preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'turn_plan' }), depthBudgetFor(plan({ preset: 'single_thinking', spawnChecker: false })));
    expect(m.plan).toMatchObject({ lane: 'standard', source: 'turn_plan', spawnChecker: false });
  });
});
