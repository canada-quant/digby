/**
 * decision-outcome-labels.ts — the compute-policy labels (2026-09-26, depth-UX
 * Module A): harness / user-behaviour `actual`s for compute_policy (depth +
 * research_request, per label), drafts_agree and revision_material, recorded
 * against the stash the DepthPlan carried so rows pair by decisionId.
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
import { presetPlan, type DepthPlan } from './compute-policy-gate';
import {
  COMPUTE_POLICY_ESCALATION_WINDOW_MS, COMPUTE_POLICY_LABELS, COMPUTE_POLICY_PRIMARY_LABEL, COMPUTE_POLICY_REASK_WINDOW_MS, THUMBS_SLOW_REASONS,
  deriveComputePolicyDepthActual, deriveResearchRequestActual, escalatedLabelRefused, labelComputePolicyOutcome, labelDraftsAgreeOutcome, labelRevisionMaterialOutcome,
  type ComputePolicyTurnFacts,
} from './decision-outcome-labels';
import { OUTCOME_LABEL_FOR_FIT, OUTCOME_LABEL_FALLBACK_FOR_FIT } from './decision-gate-fit';

const record = recordLoopMetric as jest.Mock;
beforeEach(() => { record.mockReset(); delete process.env.DECISION_GATE_THRESHOLD_COMPUTE_POLICY; });

const rows = () => record.mock.calls.map((c) => c[0].meta);

const decision = (depth: string, conf = 0.9, extra: Record<string, any> = {}) => ({
  id: 'cp1', backend: 'TypeSafe Jev', ms: 10, mode: 'shadow' as const, calibrated: true, stateHash: 'sh', questionsHash: 'qh',
  answers: {
    depth: { type: 'choice' as const, choice: depth, confidence: conf, probabilities: { [depth]: conf } },
    stakes: { type: 'noul' as const, noul: 0.1 },
    needs_live_web: { type: 'noul' as const, noul: 0.4 },
    research_request: { type: 'noul' as const, noul: 0.05 },
    ...extra,
  },
});
const stashFor = (depth: string, conf = 0.9) => stashDecision(decision(depth, conf), 'compute_policy');

const light: ComputePolicyTurnFacts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: false, checkerMerged: false };
const mid: ComputePolicyTurnFacts = { leadToolCalls: 1, webToolCalls: 1, finalChars: 1200, checkerSpawned: true, checkerMerged: false };
const heavyMerged: ComputePolicyTurnFacts = { leadToolCalls: 4, webToolCalls: 3, finalChars: 3000, checkerSpawned: true, checkerMerged: true };
const heavyUnmerged: ComputePolicyTurnFacts = { leadToolCalls: 4, webToolCalls: 3, finalChars: 3000, checkerSpawned: false, checkerMerged: false };

describe('pure derivations', () => {
  it('registry: seven labels (escalated primary — the fit label; escalated_late = a tap after the window, cp/labels; facts = the finalize row, the ruler\'s window-closed fallback); windows 30 min / 5 min; slow thumbs reasons never bump', () => {
    // backlog DOI-21 (2026-09-28): + `machine` — the window closer's harness-proxy row for supervisor / machine turns.
    expect(COMPUTE_POLICY_LABELS).toEqual(['escalated', 'escalated_late', 'facts', 'reask_5m', 'thumbs', 'revision_material', 'checker_skipped_material', 'machine']);
    expect(COMPUTE_POLICY_PRIMARY_LABEL).toBe('escalated');
    expect(OUTCOME_LABEL_FOR_FIT.compute_policy).toBe(COMPUTE_POLICY_PRIMARY_LABEL);
    expect(OUTCOME_LABEL_FALLBACK_FOR_FIT.compute_policy).toEqual({ label: 'facts', afterMs: COMPUTE_POLICY_ESCALATION_WINDOW_MS });
    expect(COMPUTE_POLICY_ESCALATION_WINDOW_MS).toBe(30 * 60_000);
    expect(COMPUTE_POLICY_REASK_WINDOW_MS).toBe(5 * 60_000);
    expect(THUMBS_SLOW_REASONS.has('slow')).toBe(true);
  });

  it('base depth from the harness facts (checker-route vocabulary): light ⇒ simple_lookup, mid ⇒ ordinary, heavy+merged ⇒ contestable, heavy+unmerged ⇒ unknown, no facts ⇒ unknown', () => {
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: false, facts: light })).toBe('simple_lookup');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: false, facts: mid })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: false, facts: heavyMerged })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: false, facts: heavyUnmerged })).toBeNull();
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: false })).toBeNull();
    // The finalize's facts-only row is the base, never bumped.
    expect(deriveComputePolicyDepthActual({ label: 'facts', facts: light })).toBe('simple_lookup');
    expect(deriveComputePolicyDepthActual({ label: 'facts', facts: heavyMerged, escalated: true })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'facts', facts: heavyUnmerged })).toBeNull();
  });

  it('a Dig-deeper tap BUMPS: to ordinary when no checker ran, to contestable when one did or the tap asked for research; never lowers a heavier base', () => {
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', facts: light })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true, escalatedTo: 'research', facts: light })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true, escalatedTo: 'research', facts: mid })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', facts: heavyUnmerged })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', facts: heavyMerged })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'escalated', escalated: true })).toBe('ordinary');
  });

  it('reask_5m and thumbs-down (non-slow) bump the same way; thumbs up / slow / no re-ask keep the base', () => {
    expect(deriveComputePolicyDepthActual({ label: 'reask_5m', reasked: true, facts: light })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'reask_5m', reasked: false, facts: light })).toBe('simple_lookup');
    expect(deriveComputePolicyDepthActual({ label: 'thumbs', thumbs: 'down', thumbsReason: 'wrong', facts: mid })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'thumbs', thumbs: 'down', thumbsReason: 'slow', facts: mid })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'thumbs', thumbs: 'up', facts: light })).toBe('simple_lookup');
  });

  it('revision_material: material ⇒ contestable; wording-only caps at ordinary; checker_skipped_material: material ⇒ contestable, else simple_lookup (the skip was right)', () => {
    expect(deriveComputePolicyDepthActual({ label: 'revision_material', material: true, facts: light })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'revision_material', material: false, facts: heavyMerged })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'revision_material', material: false, facts: light })).toBe('simple_lookup');
    expect(deriveComputePolicyDepthActual({ label: 'revision_material', material: null, facts: mid })).toBe('ordinary');
    expect(deriveComputePolicyDepthActual({ label: 'checker_skipped_material', material: true, facts: light })).toBe('contestable');
    expect(deriveComputePolicyDepthActual({ label: 'checker_skipped_material', material: false, facts: heavyUnmerged })).toBe('simple_lookup');
  });

  it('research_request actual (audit 2026-09-26): the L3 preset ⇒ true; a CHOSEN rung ⇒ research?; a FORCED-rung tap ⇒ null (no signal about what the MESSAGE asked — no row); the window closing untapped ⇒ false; the kill switch restores the forced-rung label', () => {
    expect(deriveResearchRequestActual({ label: 'escalated', requestedPreset: 'deep_research' })).toBe(true);
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'chosen' })).toBe(true);
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', rungChoice: 'chosen' })).toBe(false);
    // the rung a tap runs is the server's next-rung rule (an L2 row ⇒ research) — never the user's wish
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'forced' })).toBeNull();
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'research' })).toBeNull();
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', requestedPreset: 'thinking' })).toBeNull();
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: false, windowClosed: true, requestedPreset: 'thinking' })).toBe(false);
    expect(deriveResearchRequestActual({ label: 'escalated', escalated: false })).toBeNull();
    process.env.COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG = '1';
    try {
      expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'forced' })).toBe(true);
      expect(deriveResearchRequestActual({ label: 'escalated', escalated: true, escalatedTo: 'verify', rungChoice: 'forced' })).toBe(false);
    } finally { delete process.env.COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG; }
  });
});

describe('labelComputePolicyOutcome', () => {
  it('escalated: a depth row (label escalated, agreed judged at the act cutoff), paired by the stash id; a FORCED-rung tap writes NO research_request row, a CHOSEN rung does (audit 2026-09-26)', () => {
    labelComputePolicyOutcome(stashFor('simple_lookup', 0.95), { label: 'escalated', escalated: true, escalatedTo: 'verify', rungChoice: 'forced', facts: light, sessionId: 'chat1', requestedPreset: 'single_thinking' });
    let r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ phase: 'outcome', id: 'cp1', purpose: 'compute_policy', question: 'depth', label: 'escalated', actual: 'ordinary', agreed: false, acted: false, site: 'compute_policy', escalated: true, escalatedTo: 'verify', rungChoice: 'forced', leadToolCalls: 0, checkerSpawned: false, requestedPreset: 'single_thinking' });
    expect(r[0].note).toContain('escalated:1→verify (forced rung)');
    expect(record.mock.calls[0][0].sessionId).toBe('chat1');
    // the prod shape of the mislabel: an L2 row's tap runs 'research' by the server's rule — before the audit this wrote research_request:true against a 0.05 noul
    record.mockReset();
    labelComputePolicyOutcome(stashFor('simple_lookup', 0.95), { label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'forced', facts: mid });
    r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ question: 'depth', actual: 'contestable', escalatedTo: 'research', rungChoice: 'forced' });
    // an explicit user pick of the rung IS the signal the question asks about
    record.mockReset();
    labelComputePolicyOutcome(stashFor('simple_lookup', 0.95), { label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'chosen', facts: light });
    r = rows();
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ question: 'research_request', label: 'escalated', actual: true, agreed: false, rungChoice: 'chosen' });
  });

  it("the finalize's facts-only row (label 'facts') on a light turn agrees with a simple_lookup prediction; the plan itself (contract fields) is accepted in place of the stash", () => {
    const plan: DepthPlan = { ...presetPlan('thinking'), source: 'gate_shadow', mode: 'shadow', decisionId: 'cp1', answers: decision('simple_lookup').answers };
    labelComputePolicyOutcome(plan, { label: 'facts', facts: light });
    const r = rows();
    expect(r).toHaveLength(1); // no research_request row on a secondary label
    expect(r[0]).toMatchObject({ id: 'cp1', question: 'depth', actual: 'simple_lookup', agreed: true, label: 'facts', note: expect.stringContaining('facts only') });
    expect(r[0]).not.toHaveProperty('escalated');
  });

  it("review 2026-09-26: `escalated` is written ONCE — at the tap, or when the 30-min window closes untapped (windowClosed:true); a premature escalated:false is REFUSED (nothing written)", () => {
    labelComputePolicyOutcome(stashFor('simple_lookup'), { label: 'escalated', escalated: false, facts: light });
    labelComputePolicyOutcome(stashFor('simple_lookup'), { label: 'escalated', facts: light });
    labelComputePolicyOutcome(stashFor('simple_lookup'), { label: 'escalated', escalated: false, failed: true });
    expect(record).not.toHaveBeenCalled();
    labelComputePolicyOutcome(stashFor('simple_lookup', 0.95), { label: 'escalated', escalated: false, windowClosed: true, facts: light, sessionId: 'chat1', requestedPreset: 'thinking' });
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ question: 'depth', label: 'escalated', escalated: false, actual: 'simple_lookup', agreed: true, note: expect.stringContaining('window closed') });
    expect(r[1]).toMatchObject({ question: 'research_request', label: 'escalated', actual: false, agreed: true });
    // The pure guard the writer applies.
    expect(escalatedLabelRefused({ label: 'escalated', escalated: false })).toBe(true);
    expect(escalatedLabelRefused({ label: 'escalated' })).toBe(true);
    expect(escalatedLabelRefused({ label: 'escalated', escalated: true })).toBe(false);
    expect(escalatedLabelRefused({ label: 'escalated', escalated: false, windowClosed: true })).toBe(false);
    expect(escalatedLabelRefused({ label: 'facts', escalated: false })).toBe(false);
    expect(escalatedLabelRefused({ label: 'thumbs' })).toBe(false);
  });

  it('secondary labels write ONE depth row each (no research row); a failed turn writes actual null; a heavy unmerged turn is unknown', () => {
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'thumbs', thumbs: 'down', thumbsReason: 'wrong', facts: mid, acted: true });
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'reask_5m', reasked: false, facts: heavyUnmerged });
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'revision_material', material: true, failed: true });
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ question: 'depth', label: 'thumbs', actual: 'contestable', agreed: false, acted: true });
    expect(r[1]).toMatchObject({ question: 'depth', label: 'reask_5m', actual: null });
    expect(r[1].agreed).toBeUndefined();
    expect(r[1].note).toContain('depth unknown');
    expect(r[2]).toMatchObject({ question: 'depth', label: 'revision_material', actual: null, note: expect.stringContaining('run failed') });
  });

  it('never throws and writes nothing for a foreign stash, a malformed stash or an unknown label', () => {
    labelComputePolicyOutcome(stashDecision({ ...decision('ordinary'), id: 'w1' }, 'wake_triage'), { label: 'escalated', escalated: true });
    labelComputePolicyOutcome({ nope: true }, { label: 'escalated', escalated: true });
    labelComputePolicyOutcome(null, { label: 'escalated', escalated: true });
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'made_up' as any });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('labelDraftsAgreeOutcome / labelRevisionMaterialOutcome', () => {
  const agreeStash = (p: number) => stashDecision({ id: 'da1', backend: 'TypeSafe Jev', ms: 5, mode: 'act', calibrated: true, answers: { agree: { type: 'noul', noul: p } } }, 'drafts_agree');
  const revStash = (p: number) => stashDecision({ id: 'rm1', backend: 'TypeSafe Jev', ms: 5, mode: 'shadow', calibrated: true, answers: { material: { type: 'noul', noul: p } } }, 'revision_material');

  it("drafts_agree: actual = the reconcile did NOT change a material claim; null when it never landed; the row's `acted` = the reconcile was skipped", () => {
    labelDraftsAgreeOutcome(agreeStash(0.9), { material: false, sessionId: 'c', acted: true });
    labelDraftsAgreeOutcome(agreeStash(0.9), { material: true });
    labelDraftsAgreeOutcome(agreeStash(0.9), { material: null, note: 'interrupted by deploy' });
    const r = rows();
    expect(r[0]).toMatchObject({ purpose: 'drafts_agree', id: 'da1', question: 'agree', actual: true, agreed: true, acted: true, site: 'drafts_agree', material: false, inActBand: true });
    expect(r[0].note).toContain('reconcile skipped (acted)');
    expect(r[1]).toMatchObject({ actual: false, agreed: false, acted: false, material: true });
    expect(r[2]).toMatchObject({ actual: null, note: expect.stringContaining('interrupted by deploy') });
    expect(r[2].agreed).toBeUndefined();
  });

  it('drafts_agree (2026-09-26 label semantics): `label` + `source` ride the row (meta.label, extra.source, src: in the note) — no OUTCOME_LABEL_FOR_FIT entry, so every label still enters the fit', () => {
    labelDraftsAgreeOutcome(agreeStash(0.9), { material: false, acted: false, label: 'reconcile', source: 'late_check' });
    labelDraftsAgreeOutcome(agreeStash(0.9), { material: true, acted: true, label: 'thumbs_down', source: 'feedback' });
    const r = rows();
    expect(r[0]).toMatchObject({ purpose: 'drafts_agree', label: 'reconcile', source: 'late_check', actual: true, acted: false, inActBand: true });
    expect(r[0].note).toContain('src:late_check');
    expect(r[1]).toMatchObject({ label: 'thumbs_down', source: 'feedback', actual: false, agreed: false, acted: true, inActBand: true });
    expect(OUTCOME_LABEL_FOR_FIT).not.toHaveProperty('drafts_agree');
  });

  it('revision_material: actual = thumbs-down or escalation after the revision; unknown ⇒ null; the adapter note rides the row', () => {
    labelRevisionMaterialOutcome(revStash(0.1), { thumbsDown: false, escalated: false, sessionId: 'c', acted: true, note: 'pill:checked (rewrite withheld)' });
    labelRevisionMaterialOutcome(revStash(0.1), { escalated: true });
    labelRevisionMaterialOutcome(revStash(0.1), { unknown: true });
    const r = rows();
    expect(r[0]).toMatchObject({ purpose: 'revision_material', id: 'rm1', question: 'material', actual: false, agreed: true, acted: true, site: 'revision_material', inActBand: true });
    expect(r[0].note).toContain('rewrite skipped (acted)');
    expect(r[0].note).toContain('pill:checked (rewrite withheld)');
    expect(r[1]).toMatchObject({ actual: true, agreed: false, escalated: true });
    expect(r[1].note).not.toContain('pill:');
    expect(r[2]).toMatchObject({ actual: null, note: expect.stringContaining('window not closed') });
  });

  it('a stash of the wrong purpose or without the question writes nothing', () => {
    labelDraftsAgreeOutcome(revStash(0.1), { material: false });
    labelRevisionMaterialOutcome(agreeStash(0.9), { escalated: true });
    labelDraftsAgreeOutcome(stashDecision({ id: 'x', backend: 'b', ms: 1, mode: 'act', answers: { other: { type: 'noul', noul: 0.5 } } }, 'drafts_agree'), { material: false });
    expect(record).not.toHaveBeenCalled();
  });
});

// ── cp/labels (2026-09-26): escalated_late, the label source, the finalize turn stats ──
describe('cp/labels: escalated_late + source + turn stats', () => {
  const facts: ComputePolicyTurnFacts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 200, checkerSpawned: false, checkerMerged: false };
  it('escalated_late: a SECONDARY depth row (bumped like a tap), no research_request row, source in extra + note; the fit ignores the label', () => {
    labelComputePolicyOutcome(stashFor('simple_lookup'), { label: 'escalated_late', escalated: true, escalatedTo: 'verify', facts, source: 'dig_deeper_late' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ purpose: 'compute_policy', question: 'depth', actual: 'ordinary', label: 'escalated_late', source: 'dig_deeper_late', escalated: true, escalatedTo: 'verify' });
    expect(String(rows()[0].note)).toContain('escalated_late src:dig_deeper_late; late tap→verify');
    expect(deriveComputePolicyDepthActual({ label: 'escalated_late', escalated: true, escalatedTo: 'research', facts })).toBe('contestable');
  });
  it('facts: source finalize + the turn stats (ttft / completion / spend rounded, council) ride extra in the first 12 keys; the note names the pill state', () => {
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'facts', facts, requestedPreset: 'thinking', source: 'finalize', turn: { ttftMs: 1500.4, completionMs: 90_000, spentUsd: 0.09876, council: 'none', checkState: 'checked', escalationRung: undefined } });
    const r = rows()[0];
    expect(r).toMatchObject({ label: 'facts', source: 'finalize', requestedPreset: 'thinking', ttftMs: 1500, completionMs: 90_000, spentUsd: 0.0988, council: 'none' });
    expect(String(r.note)).toContain('facts src:finalize; facts only; check:checked');
    expect(r.escalated).toBeUndefined();
  });
  it('an unknown source / turn is simply absent (older callers keep their rows byte-for-byte)', () => {
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'facts', facts });
    expect(rows()[0].source).toBeUndefined();
    expect(rows()[0].ttftMs).toBeUndefined();
    expect(String(rows()[0].note)).toMatch(/^facts; facts only; tools:0/);
  });
});

describe('2026-09-26 (audit) — meta.segment on every compute_policy outcome row; excludeFromFit rides the facts row', () => {
  it('a stash with a segment stamps it ROW-OWN on the depth row (and the research_request row) — after the 12-key extra, so a full facts row keeps it', () => {
    const stash = { ...stashFor('ordinary')!, segment: 'supervisor' };
    labelComputePolicyOutcome(stash, { label: 'facts', facts: light, requestedPreset: 'thinking', source: 'finalize', turn: { ttftMs: 1500, completionMs: 90_000, spentUsd: 0.1, council: 'none' }, excludeFromFit: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ purpose: 'compute_policy', question: 'depth', label: 'facts', segment: 'supervisor', excludeFromFit: true, council: 'none' });
    expect(String(rows()[0].note)).toContain('no chip (excluded from fit)');
    record.mockReset();
    // a USER-chosen research rung (a forced rung writes no research_request row — telemetry-readiness-8)
    labelComputePolicyOutcome(stash, { label: 'escalated', escalated: true, escalatedTo: 'research', rungChoice: 'chosen', facts: light, source: 'dig_deeper' });
    expect(rows().map(r => `${r.question}:${r.segment}:${r.excludeFromFit}`)).toEqual(['depth:supervisor:undefined', 'research_request:supervisor:undefined']);
  });
  it('a stash without a segment writes no segment / excludeFromFit key (pre-change rows byte-for-byte); a failed finalize keeps the tag', () => {
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'facts', facts: light });
    expect(rows()[0]).not.toHaveProperty('segment');
    expect(rows()[0]).not.toHaveProperty('excludeFromFit');
    record.mockReset();
    labelComputePolicyOutcome(stashFor('ordinary'), { label: 'facts', facts: light, failed: true, excludeFromFit: true });
    expect(rows()[0]).toMatchObject({ actual: null, excludeFromFit: true });
  });
});
