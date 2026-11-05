/**
 * GHOST = ONE LEAD INFERENCE — owner ruling 2026-11-03.
 *
 * The owner reported on the Digby Edge: ghost mode showed "Thinking 28s / 2
 * steps / Digby is digging in — the Double Checker is researching alongside…".
 * Ghost mode (#1888) had been built to ROUTE every leg — lead, Double Checker,
 * council colleagues — onto the admin-designated abliterated endpoint, so a
 * ghost 'thinking' turn still spent a second inference and still streamed the
 * Double Checker banner. The owner's ruling retires that: ONE private
 * inference, no checker, no ensemble, no council, no banner.
 *
 * These cases pin the two halves of the fix as pure leaves:
 *   1. `ghostSingleModelPlan` collapses ANY plan shape to one answer.
 *   2. `shouldSpawnChecker` refuses to spawn for a ghost run STRUCTURALLY —
 *      belt-and-braces, so a future seam handing a checker-bearing plan to a
 *      ghost run still cannot spawn one (the 2026-11-03 "one rule in one
 *      place" lesson: grep for the DECISION, not the helper name).
 *
 * The end-to-end pins (exactly one model call, no checker) live in
 * chat-agent.service.test.ts 'ghost mode routing + privacy'.
 */

import { ghostSingleModelPlan, GHOST_SINGLE_MODEL_PRESET, type GhostCollapsiblePlan } from './ghost-runtime';
import { shouldSpawnChecker } from './compute-policy-wiring';
import type { DepthPlan } from '../platform/compute-policy-gate';

const plan = (over: Partial<DepthPlan> = {}): DepthPlan => ({
  preset: 'thinking',
  spawnChecker: true,
  checkerWaitMs: 0,
  leadEffort: 'high',
  council: 'none',
  reason: 'preset thinking',
  source: 'preset',
  mode: 'off',
  ...over,
});

describe('ghostSingleModelPlan — ONE lead inference (owner 2026-11-03)', () => {
  it('collapses the L2 thinking preset: checker off, no wait, no council', () => {
    const out = ghostSingleModelPlan(plan());
    expect(out.preset).toBe(GHOST_SINGLE_MODEL_PRESET);
    expect(out.spawnChecker).toBe(false);
    expect(out.checkerWaitMs).toBe(0);
    expect(out.council).toBe('none');
  });

  it('collapses the L3 council preset too (a ghost chat stored deep_research runs no colleagues)', () => {
    const out = ghostSingleModelPlan(plan({ preset: 'deep_research', spawnChecker: false, leadEffort: 'max' }));
    expect(out.preset).toBe(GHOST_SINGLE_MODEL_PRESET);
    expect(out.spawnChecker).toBe(false);
    expect(out.council).toBe('none');
  });

  it('collapses the STAKES path (a blocking checkerWaitMs becomes 0 — there is nothing to wait for)', () => {
    const out = ghostSingleModelPlan(plan({ checkerWaitMs: 90_000, leadEffort: 'max', source: 'escalation', rung: 'verify' }));
    expect(out.checkerWaitMs).toBe(0);
    expect(out.spawnChecker).toBe(false);
  });

  it('collapses a gate-ACTED plan that ADDED a background council', () => {
    const out = ghostSingleModelPlan(plan({ source: 'gate_act', council: 'background', spawnChecker: true }));
    expect(out.council).toBe('none');
    expect(out.spawnChecker).toBe(false);
  });

  it('collapses a lane-checked plan and lands it on the standard lane (never the checked lane line)', () => {
    const out = ghostSingleModelPlan(plan({ source: 'turn_plan', lane: 'checked' }));
    expect(out.lane).toBe('standard');
  });

  it('keeps leadEffort and appends the collapse to `reason` — the audit trail still says what was overridden', () => {
    const out = ghostSingleModelPlan(plan({ leadEffort: 'max', reason: 'gate act: hard question' }));
    expect(out.leadEffort).toBe('max');
    expect(out.reason).toContain('gate act: hard question');
    expect(out.reason).toContain('ghost');
  });

  it('is pure — the input plan is not mutated', () => {
    const input = plan();
    const snapshot = JSON.stringify(input);
    ghostSingleModelPlan(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('accepts the structural subset (a caller holding a narrowed plan still gets the shape)', () => {
    const narrowed: GhostCollapsiblePlan = { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high', council: 'none' };
    const out = ghostSingleModelPlan(narrowed);
    expect(out.spawnChecker).toBe(false);
    expect(out.preset).toBe('single_thinking');
  });
});

describe('shouldSpawnChecker — a ghost run never spawns a second model', () => {
  const base = { plan: { spawnChecker: true, preset: 'thinking' as const }, machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false };

  it('refuses a ghost run even when the plan says spawn (structural, not a plan flag)', () => {
    expect(shouldSpawnChecker({ ...base, ghost: true })).toBe(false);
  });

  it('still spawns for the same plan when it is NOT ghost (behaviour preserved)', () => {
    expect(shouldSpawnChecker({ ...base })).toBe(true);
    expect(shouldSpawnChecker({ ...base, ghost: false })).toBe(true);
  });

  it('the pre-existing refusals still win (council, machine rails, unservable seat)', () => {
    expect(shouldSpawnChecker({ ...base, isCouncil: true })).toBe(false);
    expect(shouldSpawnChecker({ ...base, machineTurnSkipsChecker: true })).toBe(false);
    expect(shouldSpawnChecker({ ...base, checkerSeatProblem: 'no servable model' })).toBe(false);
  });

  it('a ghost run with a plan that already says no checker still says no (idempotent)', () => {
    expect(shouldSpawnChecker({ ...base, plan: { spawnChecker: false, preset: 'single_thinking' }, ghost: true })).toBe(false);
  });
});