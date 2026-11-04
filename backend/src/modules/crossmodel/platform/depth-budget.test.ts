/** depth-budget.ts (2026-09-26, depth-UX Module A) — defaults, env overrides, the time bound; NO spend bound since 2026-09-27 (owner: no hidden cost caps). */
import * as depthBudget from './depth-budget';
import {
  DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING, DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT,
  backgroundBoundMs, depthBudgetBackgroundBoundDisabled, depthBudgetDisabled, depthBudgetFor, depthBudgetMaxBackgroundMs, type DepthBudget,
} from './depth-budget';

const ENV_KEYS = ['DEPTH_BUDGET_MAX_USD', 'DEPTH_BUDGET_MAX_BACKGROUND_MS', 'DEPTH_BUDGET_DISABLED'];
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

const plan = (over: Partial<Parameters<typeof depthBudgetFor>[0]> = {}) => ({ preset: 'thinking' as const, spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high' as const, council: 'none' as const, source: 'preset' as const, ...over });

describe('NO SPEND BOUND — the owner-directive regression pin (2026-09-27)', () => {
  it('DepthBudget carries NO maxUsd: the module exports no USD default / ceiling / reader, and depthBudgetFor never emits one', () => {
    expect((depthBudget as any).DEPTH_BUDGET_MAX_USD_DEFAULT).toBeUndefined();
    expect((depthBudget as any).DEPTH_BUDGET_MAX_USD_CEILING).toBeUndefined();
    expect((depthBudget as any).depthBudgetMaxUsd).toBeUndefined();
    const b: DepthBudget = depthBudgetFor(plan());
    expect(b).not.toHaveProperty('maxUsd');
    expect(Object.keys(b).sort()).toEqual(['checker', 'checkerEffort', 'council', 'maxBackgroundMs']);
  });
  it('the retired DEPTH_BUDGET_MAX_USD env is dead: setting it changes nothing', () => {
    process.env.DEPTH_BUDGET_MAX_USD = '0.25';
    expect(depthBudgetFor(plan())).toEqual({ checker: true, checkerEffort: 'high', council: false, maxBackgroundMs: 15 * 60_000 });
  });
});

describe('env', () => {
  it('maxBackgroundMs: default 15 min, clamped 60 s..40 min', () => {
    expect(depthBudgetMaxBackgroundMs()).toBe(DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT);
    expect(DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT).toBe(15 * 60_000);
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '120000';
    expect(depthBudgetMaxBackgroundMs()).toBe(120_000);
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '5';
    expect(depthBudgetMaxBackgroundMs()).toBe(60_000);
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '99999999';
    expect(depthBudgetMaxBackgroundMs()).toBe(DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING);
  });
  it('DEPTH_BUDGET_DISABLED=1 / true / on', () => {
    expect(depthBudgetDisabled()).toBe(false);
    for (const v of ['1', 'true', 'on', ' ON ']) { process.env.DEPTH_BUDGET_DISABLED = v; expect(depthBudgetDisabled()).toBe(true); }
    process.env.DEPTH_BUDGET_DISABLED = '0';
    expect(depthBudgetDisabled()).toBe(false);
  });
});

describe('depthBudgetFor', () => {
  it('L2 preset: one checker at high, no council; L1: neither; L3: council', () => {
    expect(depthBudgetFor(plan())).toEqual({ checker: true, checkerEffort: 'high', council: false, maxBackgroundMs: 15 * 60_000 });
    expect(depthBudgetFor(plan({ preset: 'single_thinking', spawnChecker: false }))).toMatchObject({ checker: false, council: false });
    expect(depthBudgetFor(plan({ preset: 'deep_research', spawnChecker: false }))).toMatchObject({ checker: false, council: true });
  });
  it("the stakes path implies a checker at max; a gate `council:'background'` is NOT a council that runs (audit 2026-09-26 routing-unify-3 — nothing consumes it)", () => {
    expect(depthBudgetFor(plan({ spawnChecker: false, checkerWaitMs: 90_000, leadEffort: 'max' }))).toMatchObject({ checker: true, checkerEffort: 'max' });
    expect(depthBudgetFor(plan({ leadEffort: 'max' }))).toMatchObject({ checkerEffort: 'max' });
    expect(depthBudgetFor(plan({ council: 'background' }))).toMatchObject({ council: false });
  });
  it('review 2026-09-26: an escalation plan is read from its `rung` ONLY — verify ⇒ checker, research ⇒ council, no rung ⇒ neither', () => {
    expect(depthBudgetFor(plan({ source: 'escalation', rung: 'research', spawnChecker: false, council: 'background' }))).toMatchObject({ checker: false, council: true });
    expect(depthBudgetFor(plan({ source: 'escalation', rung: 'verify', spawnChecker: true }))).toMatchObject({ checker: true, council: false });
    expect(depthBudgetFor(plan({ source: 'escalation', rung: null, spawnChecker: false }))).toMatchObject({ checker: false, council: false });
    // An escalation plan with no rung stamped (a consumer-built shape) opens nothing — `source` alone never opens a rung.
    expect(depthBudgetFor(plan({ source: 'escalation', spawnChecker: true, council: 'background', preset: 'deep_research' }))).toMatchObject({ checker: false, council: false });
  });
  it('the time-bound env override rides the budget', () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '300000';
    expect(depthBudgetFor(plan())).toMatchObject({ maxBackgroundMs: 300_000 });
  });
});

// (`budgetVerdict` / `widenForRung` were DELETED 2026-09-26 — audit budgets-cost-2 /
// docs-drift-4: no runtime caller; the one-checker / one-council rule lives in the
// persisted rung ladder (compute-policy-wiring nextRungForMessage). `maxUsd` /
// `depthBudgetMaxUsd` were DELETED 2026-09-27 — owner: no hidden cost caps.)

describe('backgroundBoundMs — maxBackgroundMs applied through a job\'s own cap (audit 2026-09-26, settings-switches-5: the knob was recorded and enforced nowhere)', () => {
  const CHECKER_CAP = 900_000;   // CROSS_CHECK_HARD_MS
  const COUNCIL_CAP = 2_400_000; // COUNCIL_LEAD_BACKSTOP_MS
  it('default knob (15 min): the checker cap stands (equal ⇒ cap), a background council lead is bounded to 15 min by the budget', () => {
    const b = depthBudgetFor(plan());
    expect(backgroundBoundMs(b, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    expect(backgroundBoundMs(b, COUNCIL_CAP)).toEqual({ ms: DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT, source: 'depth_budget' });
  });
  it('DEPTH_BUDGET_MAX_BACKGROUND_MS=60000 reaches both caps as the binding bound', () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    const b = depthBudgetFor(plan());
    expect(backgroundBoundMs(b, CHECKER_CAP)).toEqual({ ms: 60_000, source: 'depth_budget' });
    expect(backgroundBoundMs(b, COUNCIL_CAP)).toEqual({ ms: 60_000, source: 'depth_budget' });
  });
  it('the switch can only SHORTEN a job: a knob at / above the cap, a garbage or missing budget, and a sub-minute value all leave the cap', () => {
    expect(backgroundBoundMs({ maxBackgroundMs: CHECKER_CAP }, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    expect(backgroundBoundMs({ maxBackgroundMs: 2_000_000 }, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    expect(backgroundBoundMs({ maxBackgroundMs: Number.NaN }, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    expect(backgroundBoundMs(null, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    expect(backgroundBoundMs({ maxBackgroundMs: 5 }, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'cap' });
    // a non-positive cap never yields 0 — the 40-min ceiling stands in
    expect(backgroundBoundMs({ maxBackgroundMs: 60_000 }, 0)).toEqual({ ms: 60_000, source: 'depth_budget' });
    expect(backgroundBoundMs({ maxBackgroundMs: 3_000_000 }, 0)).toEqual({ ms: DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING, source: 'cap' });
  });
  it('kill switch: DEPTH_BUDGET_DISABLED=1 leaves the cap alone (source disabled); the opts override too', () => {
    process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS = '60000';
    const b = depthBudgetFor(plan());
    expect(depthBudgetBackgroundBoundDisabled()).toBe(false);
    process.env.DEPTH_BUDGET_DISABLED = '1';
    expect(depthBudgetBackgroundBoundDisabled()).toBe(true);
    expect(backgroundBoundMs(b, CHECKER_CAP)).toEqual({ ms: CHECKER_CAP, source: 'disabled' });
    delete process.env.DEPTH_BUDGET_DISABLED;
    expect(backgroundBoundMs(b, CHECKER_CAP, { disabled: true })).toEqual({ ms: CHECKER_CAP, source: 'disabled' });
    expect(backgroundBoundMs(b, CHECKER_CAP, { disabled: false })).toEqual({ ms: 60_000, source: 'depth_budget' });
  });
});
