/**
 * decision-gate-registry.ts — backlog 2026-09-28:
 *   E13  the registry LIFECYCLE decisions (tool_intent retire / self_audit
 *        shadow_review with a review date / wake_effort shadow) and the
 *        `retired` join (PURPOSE_RETIRED + lift env);
 *   E11  the bars row documents the volume-scaled label floor (minLabelsFloor,
 *        volumeScaleDays, volumeRule) and reports the kill switch.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { DECISION_ROLE_REGISTRY, decisionRegistryRow, listDecisionRegistry } from './decision-gate-registry';
import { PURPOSE_ACT_CAPS, PURPOSE_RETIRED, PURPOSE_RETIRED_ON_HUMAN_TURNS, purposeRetiredOnHumanTurns, humanRetireLiftEnv } from './decision-gate-modes';
import { READINESS_MIN_LABELS_FLOOR, READINESS_VOLUME_RULE, READINESS_VOLUME_SCALE_DAYS } from './decision-gate-fit';

const ENV = ['DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED', 'DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', 'DECISION_GATE_CHECKER_ROUTE_HUMAN_RETIRE_LIFTED'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('E13 — registry lifecycle decisions', () => {
  it('tool_intent: retire (tier 3, in PURPOSE_RETIRED and PURPOSE_ACT_CAPS); self_audit: shadow_review with an ISO review date + a bar; wake_effort: shadow with the re-pose named; every other row carries none', () => {
    expect(DECISION_ROLE_REGISTRY.tool_intent.lifecycle).toMatchObject({ decision: 'retire', why: expect.stringMatching(/no act consumer/) });
    expect(DECISION_ROLE_REGISTRY.tool_intent.tier).toBe(3);
    expect(PURPOSE_RETIRED).toHaveProperty('tool_intent');
    expect(PURPOSE_ACT_CAPS).toHaveProperty('tool_intent');
    expect(DECISION_ROLE_REGISTRY.self_audit.lifecycle).toMatchObject({ decision: 'shadow_review', reviewBy: expect.stringMatching(/^20\d\d-\d\d-\d\d$/), bar: expect.stringMatching(/AUROC/), why: expect.any(String) });
    expect(Date.parse(DECISION_ROLE_REGISTRY.self_audit.lifecycle!.reviewBy!)).toBeGreaterThan(Date.parse('2026-09-28'));
    expect(DECISION_ROLE_REGISTRY.wake_effort.lifecycle).toMatchObject({ decision: 'shadow', bar: expect.stringMatching(/supervisor_turn_noop/), why: expect.stringMatching(/AUROC 0\.541/) });
    const withLifecycle = Object.entries(DECISION_ROLE_REGISTRY).filter(([, s]) => s.lifecycle).map(([p]) => p).sort();
    // task-aware pick (2026-10-20): task_kind stays shadow (never retired — the ask must keep running) and names its next step.
    expect(DECISION_ROLE_REGISTRY.task_kind.lifecycle).toMatchObject({ decision: 'shadow', bar: expect.stringMatching(/label writer/), why: expect.stringMatching(/never retired/) });
    expect(withLifecycle).toEqual(['self_audit', 'task_kind', 'tool_intent', 'wake_effort']);
    for (const [, s] of Object.entries(DECISION_ROLE_REGISTRY)) {
      if (!s.lifecycle) continue;
      expect(['retire', 'shadow_review', 'shadow']).toContain(s.lifecycle.decision);
      expect(s.lifecycle.why.length).toBeGreaterThan(20);
      if (s.lifecycle.decision === 'retire') expect(s.tier).toBe(3);
    }
  });
  it('the row join carries `retired` (from PURPOSE_RETIRED, active unless lifted) — null for every other purpose; lifecycle rides the row', () => {
    const r = decisionRegistryRow('tool_intent');
    expect(r.retired).toMatchObject({ since: '2026-09-28', liftEnv: 'DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED', active: true });
    expect(r.lifecycle?.decision).toBe('retire');
    expect(r.actCap?.active).toBe(true);
    process.env.DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED = '1';
    expect(decisionRegistryRow('tool_intent').retired?.active).toBe(false);
    expect(decisionRegistryRow('wake_triage').retired).toBeNull();
    expect(listDecisionRegistry().filter(x => x.retired).map(x => x.purpose)).toEqual(['tool_intent']);
  });
});

describe('E11 — the bars row documents the volume-scaled floor', () => {
  it('minLabels stays the base (200), minLabelsFloor 50, volumeScaleDays 10, volumeScaled true with the rule', () => {
    const b = decisionRegistryRow('browser_driver').bars;
    expect(b).toMatchObject({ minLabels: 200, minLabelsFloor: READINESS_MIN_LABELS_FLOOR, volumeScaled: true, volumeScaleDays: READINESS_VOLUME_SCALE_DAYS, volumeRule: READINESS_VOLUME_RULE, controlGated: false });
    // A purpose with its own stricter bars keeps them beside the documented floor.
    expect(decisionRegistryRow('supervisor_turn_noop').bars).toMatchObject({ minActBandN: 30, minActBandPrecision: 0.95, minLabelsFloor: 50 });
  });
});

describe('roster 2026-10-06 B-2 — retired on HUMAN turns', () => {
  it('exactly auto_route / compute_policy / checker_route / drafts_agree; each row names its ask site and why; the registry row joins it (active unless lifted), every other purpose null', () => {
    expect(Object.keys(PURPOSE_RETIRED_ON_HUMAN_TURNS).sort()).toEqual(['auto_route', 'checker_route', 'compute_policy', 'drafts_agree']);
    for (const p of Object.keys(PURPOSE_RETIRED_ON_HUMAN_TURNS) as Array<keyof typeof PURPOSE_RETIRED_ON_HUMAN_TURNS>) {
      const row = decisionRegistryRow(p as any);
      expect(row.retiredOnHumanTurns).toMatchObject({ since: '2026-10-06', liftEnv: humanRetireLiftEnv(p), globalLiftEnv: 'DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', active: true, why: expect.any(String), sites: expect.any(String) });
      // the lift env is listed among the row's kill switches
      expect(row.killSwitches.join(' ')).toContain(humanRetireLiftEnv(p));
      // a human-turn retirement is not a registry retirement: the purpose keeps its bare default + its machine asks
      expect(row.retired).toBeNull();
    }
    expect(decisionRegistryRow('turn_plan').retiredOnHumanTurns).toBeNull();
    expect(decisionRegistryRow('revision_material').retiredOnHumanTurns).toBeNull();
  });
  it('the lift env clears ONE purpose; the global switch clears all', () => {
    process.env.DECISION_GATE_CHECKER_ROUTE_HUMAN_RETIRE_LIFTED = '1';
    expect(purposeRetiredOnHumanTurns('checker_route')).toBe(false);
    expect(purposeRetiredOnHumanTurns('compute_policy')).toBe(true);
    expect(decisionRegistryRow('checker_route').retiredOnHumanTurns?.active).toBe(false);
    process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
    expect(listDecisionRegistry().filter(r => r.retiredOnHumanTurns?.active).map(r => r.purpose)).toEqual([]);
    expect(purposeRetiredOnHumanTurns('wake_triage')).toBe(false);
  });
});
