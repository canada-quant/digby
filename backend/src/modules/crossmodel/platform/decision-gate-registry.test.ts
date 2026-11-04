/**
 * Decision-role registry (rollout self-governance, 2026-09-27): every purpose
 * the runtime knows is a registry row and vice-versa; the rows carry the
 * fields the automaton, the prompt layer and the docs rely on.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { DECISION_ROLE_REGISTRY, REGISTRY_PURPOSES, ROLLOUT_TIER_RULE, decisionRegistryRow, listDecisionRegistry, rolloutTierFor } from './decision-gate-registry';
import { DECISION_PURPOSES, PURPOSE_ACT_CAPS, PURPOSE_RETIRED } from './decision-gate-modes';
import { ACT_POLICIES, PURPOSE_CONTROL_GATED } from './decision-gate-fit';
import { TASK_KIND_MIN_P, taskKindQuestions } from './task-kind';

const runtimePurposes = DECISION_PURPOSES.map(p => p.purpose).sort();

describe('decision-gate registry — one typed source of truth for every purpose', () => {
  it('registry keys == DECISION_PURPOSES == ACT_POLICIES (a new purpose without a row fails here)', () => {
    expect([...REGISTRY_PURPOSES].sort()).toEqual(runtimePurposes);
    expect(Object.keys(ACT_POLICIES).sort()).toEqual(runtimePurposes);
    expect(runtimePurposes).toHaveLength(24); // 21 + session_topology (sessions/titles-topology, merged 2026-09-27) + turn_plan (dynamic roster 2026-10-03) + task_kind (task-aware pick 2026-10-20)
  });

  it('task_kind is a capped tier-3 evidence key: honest "no gate act consumer" text naming the consumer-owned store flag, its own kill switch, never retired', () => {
    const spec = DECISION_ROLE_REGISTRY.task_kind;
    expect(spec.tier).toBe(3);
    expect(rolloutTierFor('task_kind')).toBe(3);
    expect(PURPOSE_ACT_CAPS).toHaveProperty('task_kind');
    expect(PURPOSE_RETIRED).not.toHaveProperty('task_kind');
    expect(spec.killSwitches).toEqual(['TASK_KIND_DISABLED']);
    expect(spec.actDoes).toMatch(/no gate act consumer/);
    expect(spec.actDoes).toMatch(/modelPickKind/);
    expect(spec.actDoes).toMatch(/fail-open = \(model, lane\) evidence/);
    expect(spec.tierWhy).toMatch(/no gate act consumer/);
    expect(spec.harnessLabel).toMatch(/no outcome label writer yet/);
    expect(spec.consumerSite).toMatch(/platform\/task-kind\.ts/);
    const r = decisionRegistryRow('task_kind');
    expect(r).toMatchObject({ label: 'Task kind', question: 'kind', defaultThreshold: 0.5, retired: null, retiredOnHumanTurns: null });
    expect(r.questionShape).toMatch(/^choice/);
    expect(r.actCap).toMatchObject({ since: '2026-10-20', liftEnv: 'DECISION_GATE_TASK_KIND_ACT_CAP_DISABLED', active: true });
    // The ruler's band mirrors the classifier's usability bar (TASK_KIND_MIN_P) on the forward-order question
    // (decision-gate.test.ts pins ACT_BAND_DEFAULT_THRESHOLD to the same number).
    expect(ACT_POLICIES.task_kind).toMatchObject({ kind: 'choice_high', defaultThreshold: TASK_KIND_MIN_P });
    expect(ACT_POLICIES.task_kind.question).toBe(Object.keys(taskKindQuestions())[0]);
  });

  it('every row carries the documented fields and a valid tier with a reason', () => {
    for (const [purpose, spec] of Object.entries(DECISION_ROLE_REGISTRY)) {
      expect([1, 2, 3]).toContain(spec.tier);
      expect(spec.tierWhy.length).toBeGreaterThan(20);
      expect(spec.decides.length).toBeGreaterThan(10);
      expect(spec.consumerSite).toMatch(/\.ts/);
      expect(spec.actDoes.length).toBeGreaterThan(10);
      expect(spec.harnessLabel.length).toBeGreaterThan(10);
      expect(spec.killSwitches.length).toBeGreaterThan(0);
      expect(rolloutTierFor(purpose)).toBe(spec.tier);
    }
    expect(rolloutTierFor('probe')).toBeNull();
    expect(rolloutTierFor('nope')).toBeNull();
  });

  it('an act-capped or control-gated purpose is never tier 1; the no-consumer / retired purposes are tier 3', () => {
    for (const p of Object.keys(PURPOSE_ACT_CAPS)) expect(DECISION_ROLE_REGISTRY[p as keyof typeof DECISION_ROLE_REGISTRY].tier).not.toBe(1);
    for (const p of PURPOSE_CONTROL_GATED) expect(DECISION_ROLE_REGISTRY[p as keyof typeof DECISION_ROLE_REGISTRY].tier).not.toBe(1);
    expect(DECISION_ROLE_REGISTRY.tool_intent.tier).toBe(3);
    expect(DECISION_ROLE_REGISTRY.self_audit.tier).toBe(3);
    // The four purposes in act in prod as of 2026-09-27 are all tier 1.
    for (const p of ['wake_triage', 'sweep_triage', 'imessage_send', 'auto_route'] as const) expect(DECISION_ROLE_REGISTRY[p].tier).toBe(1);
  });

  it('a row joins the runtime facts: label, question, shape, threshold, consumer, bars, cap', () => {
    const r = decisionRegistryRow('drain_triage');
    expect(r.label).toBe('Agent-message drain triage');
    expect(r.question).toBe('disposition');
    expect(r.questionShape).toMatch(/^choice/);
    expect(r.defaultThreshold).toBe(0.85);
    expect(r.consumer).toContain('platform/drain-triage.ts');
    expect(r.bars.minLabels).toBe(200);
    expect(r.actCap?.since).toBe('2026-09-27');
    expect(r.actCap?.liftEnv).toBe('DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED');
    expect(r.actCap?.active).toBe(true);
    const s = decisionRegistryRow('supervisor_turn_noop');
    expect(s.bars.controlGated).toBe(true);
    expect(s.bars.minActBandPrecision).toBe(0.95);
    expect(s.actCap).toBeNull();
    expect(listDecisionRegistry().map(x => x.purpose)).toEqual(DECISION_PURPOSES.map(p => p.purpose));
  });

  it('the lifted cap env clears `active` (the automaton then judges the purpose on its stamp)', () => {
    process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED = '1';
    try {
      expect(decisionRegistryRow('drain_triage').actCap?.active).toBe(false);
    } finally {
      delete process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED;
    }
  });

  it('the tier rule names the three tiers once, without dates or ids', () => {
    expect(ROLLOUT_TIER_RULE).toMatch(/tier 1 .* tier 2 .* tier 3/);
    expect(ROLLOUT_TIER_RULE).not.toMatch(/20\d\d-\d\d-\d\d/);
  });
});
