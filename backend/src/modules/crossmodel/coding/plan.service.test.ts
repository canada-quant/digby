/**
 * plan.service — guard-strike marker (2026-08-30 TT-lane recurrence fix H1).
 *
 * The durable plan's completed-step notes are SELF-REPORTED by the model; a
 * guard-suppressed run used to leave them injected as ground truth every later
 * turn (the third phantom re-seed channel, after memory + journal). Pins:
 * markPlanGuardStrike stamps + renderPlanReminder warns, applyPlan carries the
 * marker across model writes (never sets/clears it), a clean-run clear removes
 * it, and mark/clear are no-ops when no plan exists.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory context store.
const store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => store.get([...ns, key].join('|')) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { store.set([...ns, key].join('|'), v); }),
}));

// applyPlan mirrors markdown into the worktree — inert in tests.
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(async () => {}),
}));

import {
  applyPlan, getPlan, markPlanGuardStrike, clearPlanGuardStrike, renderPlanReminder,
} from './plan.service';

const SID = 'sess-1';
const WT = '/tmp/wt';

const seedPlan = async () =>
  applyPlan(SID, WT, {
    goal: 'Ship the window',
    acceptance_criteria: ['bench recorded'],
    steps: [
      { text: 'run the bench', status: 'completed', note: 'merged, sha abc123' },
      { text: 'fold results', status: 'in_progress' },
    ],
  });

beforeEach(() => store.clear());

describe('guard-strike marker', () => {
  it('mark stamps the plan and the per-turn reminder warns that completions are self-reported', async () => {
    await seedPlan();
    await markPlanGuardStrike(SID, 'fabricated PR claims (GitHub 404): #338');
    const plan = await getPlan(SID);
    expect(plan?.guardStrike?.summary).toContain('#338');
    const reminder = renderPlanReminder(plan!, { step: 1, maxSteps: 10 });
    expect(reminder).toContain('EVIDENCE GUARD STRIKE');
    expect(reminder).toContain('SELF-REPORTED');
    expect(reminder).toContain('#338');
    expect(reminder).toContain('re-verify with fresh tool calls');
  });

  it('a model write (applyPlan) CARRIES the marker — it can neither set nor clear it', async () => {
    await seedPlan();
    await markPlanGuardStrike(SID, 'zero-evidence completion claims: pr_merged');
    const { plan } = await applyPlan(SID, WT, { steps: [{ text: 'run the bench', status: 'completed' }, { text: 'fold results', status: 'completed' }] });
    expect(plan.guardStrike?.summary).toContain('pr_merged');
    // …and a fresh plan written by a model has none.
    await applyPlan('sess-2', WT, { goal: 'g', steps: [{ text: 'x' }] });
    expect((await getPlan('sess-2'))?.guardStrike).toBeUndefined();
  });

  it('clear removes the marker (no-op when absent); the reminder renders clean', async () => {
    await seedPlan();
    await markPlanGuardStrike(SID, 'x');
    await clearPlanGuardStrike(SID);
    const plan = await getPlan(SID);
    expect(plan?.guardStrike).toBeUndefined();
    expect(renderPlanReminder(plan!, { step: 1, maxSteps: 10 })).not.toContain('GUARD STRIKE');
    await expect(clearPlanGuardStrike(SID)).resolves.toBeUndefined(); // absent → no-op
  });

  it('mark/clear are no-ops when the session has no plan', async () => {
    await markPlanGuardStrike('no-plan', 'x');
    expect(await getPlan('no-plan')).toBeNull();
    await expect(clearPlanGuardStrike('no-plan')).resolves.toBeUndefined();
  });
});
