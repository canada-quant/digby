/**
 * decision-outcome-labels.ts — backlog 2026-09-28 label paths:
 *   DOI-21  the compute_policy `machine` label for supervisor / machine turns
 *           (deriveMachineDepthProxy — pill updated / ≥ 3 lead tool calls ⇒
 *           contestable, 1–2 ⇒ ordinary, none + short ⇒ simple_lookup) and the
 *           row it writes (label machine, segment, excludeFromFit on the ramp);
 *   E10     the revision_material HARNESS label from the persisted verdict's
 *           source (diff ⇒ material, fallback ⇒ wording-only, gate ⇒ acted +
 *           excluded) next to the HUMAN label the thumbs / tap writers stamp;
 *           the fit prefers human (OUTCOME_LABEL_FOR_FIT) and falls back to
 *           harness (OUTCOME_LABEL_FALLBACK_FOR_FIT, afterMs 0).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('./supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));

import { recordLoopMetric } from './loop-metrics.service';
import { stashDecision } from './decision-gate';
import {
  COMPUTE_POLICY_MACHINE_LABEL, COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS_DEFAULT, MACHINE_DEPTH_CONTESTABLE_MIN_TOOL_CALLS,
  REVISION_MATERIAL_HARNESS_LABEL, REVISION_MATERIAL_HUMAN_LABEL,
  computePolicyMachineLabelMinRows, deriveMachineDepthProxy,
  labelComputePolicyOutcome, labelRevisionMaterialHarnessOutcome, labelRevisionMaterialOutcome, revisionMaterialHarnessActual,
} from './decision-outcome-labels';
import { MACHINE_SEGMENT_LABEL_FOR_FIT, OUTCOME_LABEL_FALLBACK_FOR_FIT, OUTCOME_LABEL_FOR_FIT } from './decision-gate-fit';

const record = recordLoopMetric as jest.Mock;
const rows = () => record.mock.calls.map((c) => c[0].meta);
beforeEach(() => { record.mockReset(); delete process.env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS; });

const cpStash = (depth = 'ordinary') => stashDecision({
  id: 'cp-m', backend: 'TypeSafe Jev', ms: 5, mode: 'shadow', calibrated: true, stateHash: 'sh', questionsHash: 'qh',
  answers: { depth: { type: 'choice', choice: depth, confidence: 0.8, probabilities: { [depth]: 0.8 } }, stakes: { type: 'noul', noul: 0.1 } },
} as any, 'compute_policy');
const rmStash = (p = 0.3, mode: 'shadow' | 'act' = 'shadow') => stashDecision({ id: 'rm-1', backend: 'TypeSafe Jev', ms: 5, mode, answers: { material: { type: 'noul', noul: p } } } as any, 'revision_material');

describe('DOI-21 — deriveMachineDepthProxy (pure) + the machine row', () => {
  it('pill updated ⇒ contestable; ≥ 3 lead tool calls ⇒ contestable; merged check with a tool round ⇒ contestable; 1–2 calls ⇒ ordinary; none + short ⇒ simple_lookup; none + long ⇒ ordinary; no facts ⇒ null', () => {
    expect(MACHINE_DEPTH_CONTESTABLE_MIN_TOOL_CALLS).toBe(3);
    const f = (leadToolCalls: number, finalChars: number, checkerMerged = false) => ({ leadToolCalls, finalChars, checkerMerged });
    expect(deriveMachineDepthProxy(f(0, 200), 'updated')).toBe('contestable');
    expect(deriveMachineDepthProxy(f(3, 200))).toBe('contestable');
    expect(deriveMachineDepthProxy(f(1, 200, true))).toBe('contestable');
    expect(deriveMachineDepthProxy(f(2, 5000))).toBe('ordinary');
    expect(deriveMachineDepthProxy(f(1, 200), 'checked')).toBe('ordinary');
    expect(deriveMachineDepthProxy(f(0, 200))).toBe('simple_lookup');
    expect(deriveMachineDepthProxy(f(0, 800))).toBe('simple_lookup');
    expect(deriveMachineDepthProxy(f(0, 801))).toBe('ordinary');
    expect(deriveMachineDepthProxy(f(0, 200, true))).toBe('simple_lookup'); // a merged check with NO tool round is not research
    expect(deriveMachineDepthProxy(null)).toBeNull();
  });
  it('the switches: min rows default 30, env clamped 0..10000; the fit label registry names the machine label for compute_policy', () => {
    expect(COMPUTE_POLICY_MACHINE_LABEL).toBe('machine');
    expect(computePolicyMachineLabelMinRows()).toBe(COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS_DEFAULT);
    process.env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS = '5';
    expect(computePolicyMachineLabelMinRows()).toBe(5);
    process.env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS = '0';
    expect(computePolicyMachineLabelMinRows()).toBe(0);
    process.env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS = '-3';
    expect(computePolicyMachineLabelMinRows()).toBe(30);
    process.env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS = '99999';
    expect(computePolicyMachineLabelMinRows()).toBe(10_000);
    expect(MACHINE_SEGMENT_LABEL_FOR_FIT.compute_policy).toBe('machine');
  });
  it('labelComputePolicyOutcome with label machine writes ONE depth row: the override actual, meta.label machine, the segment, source window_close, excludeFromFit when ramping; agreement is against the stashed choice', () => {
    labelComputePolicyOutcome(cpStash('ordinary'), {
      label: 'machine', source: 'window_close', segment: 'supervisor', actualOverride: 'contestable', excludeFromFit: true,
      facts: { leadToolCalls: 4, webToolCalls: 1, finalChars: 3000, checkerSpawned: false, checkerMerged: false }, turn: { checkState: 'updated' }, sessionId: 'sup-1',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ phase: 'outcome', id: 'cp-m', purpose: 'compute_policy', question: 'depth', actual: 'contestable', agreed: false, label: 'machine', segment: 'supervisor', source: 'window_close', excludeFromFit: true, leadToolCalls: 4 });
    expect(String(rows()[0].note)).toContain('machine proxy');
    expect(String(rows()[0].note)).toContain('check:updated');
    record.mockReset();
    labelComputePolicyOutcome(cpStash('ordinary'), { label: 'machine', source: 'window_close', segment: 'machine', actualOverride: 'ordinary', facts: null, sessionId: 'x' });
    expect(rows()[0]).toMatchObject({ actual: 'ordinary', agreed: true, label: 'machine', segment: 'machine' });
    expect(rows()[0].excludeFromFit).toBeUndefined();
  });
});

describe('E10 — the revision_material harness + human labels', () => {
  it('revisionMaterialHarnessActual: diff ⇒ true; fallback ⇒ false; gate ⇒ false + acted + excluded; unknown ⇒ null + excluded', () => {
    expect(revisionMaterialHarnessActual('diff')).toEqual({ actual: true, acted: false, excludeFromFit: false });
    expect(revisionMaterialHarnessActual('fallback')).toEqual({ actual: false, acted: false, excludeFromFit: false });
    expect(revisionMaterialHarnessActual('gate')).toEqual({ actual: false, acted: true, excludeFromFit: true });
    expect(revisionMaterialHarnessActual(undefined)).toEqual({ actual: null, acted: false, excludeFromFit: true });
    // Audit 2026-10-06 T6-2: a diff verdict persisted material:false (additions-only / stamp drift) changed no claim.
    expect(revisionMaterialHarnessActual('diff', false)).toEqual({ actual: false, acted: false, excludeFromFit: false });
    expect(revisionMaterialHarnessActual('diff', true)).toEqual({ actual: true, acted: false, excludeFromFit: false });
  });
  it('labelRevisionMaterialHarnessOutcome writes ONE row: label harness, extra.harness + diffSource + changed, agreement vs the noul; a gate verdict is acted + excludeFromFit; a foreign stash writes nothing', () => {
    expect(labelRevisionMaterialHarnessOutcome(rmStash(0.3), { source: 'diff', changed: 2, sessionId: 'c1', note: 'pill:updated' })).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ purpose: 'revision_material', question: 'material', actual: true, agreed: false, acted: false, label: REVISION_MATERIAL_HARNESS_LABEL, site: 'revision_material', source: 'window_close', harness: true, diffSource: 'diff', changed: 2 });
    expect(rows()[0].excludeFromFit).toBeUndefined();
    expect(String(rows()[0].note)).toContain('pill:updated');
    record.mockReset();
    expect(labelRevisionMaterialHarnessOutcome(rmStash(0.1, 'act'), { source: 'gate', sessionId: 'c1' })).toBe(true);
    expect(rows()[0]).toMatchObject({ actual: false, agreed: true, acted: true, label: 'harness', excludeFromFit: true });
    record.mockReset();
    expect(labelRevisionMaterialHarnessOutcome(rmStash(0.9), { source: 'fallback' })).toBe(true);
    expect(rows()[0]).toMatchObject({ actual: false, agreed: false, acted: false });
    record.mockReset();
    expect(labelRevisionMaterialHarnessOutcome(cpStash(), { source: 'diff' })).toBe(false);
    expect(labelRevisionMaterialHarnessOutcome(null, { source: 'diff' })).toBe(false);
    expect(rows()).toHaveLength(0);
  });
  it('the human writer stamps label human (+ extra.source human); the fit registry prefers human and falls back to harness immediately (afterMs 0)', () => {
    labelRevisionMaterialOutcome(rmStash(0.3), { thumbsDown: true, sessionId: 'c1' });
    expect(rows()[0]).toMatchObject({ purpose: 'revision_material', actual: true, label: REVISION_MATERIAL_HUMAN_LABEL, site: 'revision_material', source: 'human', thumbsDown: true });
    expect(OUTCOME_LABEL_FOR_FIT.revision_material).toBe('human');
    expect(OUTCOME_LABEL_FALLBACK_FOR_FIT.revision_material).toEqual({ label: 'harness', afterMs: 0 });
  });
});
