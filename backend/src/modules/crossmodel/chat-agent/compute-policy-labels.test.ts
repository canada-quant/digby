/**
 * Compute-policy outcome label ADAPTERS (chat-agent/compute-policy-labels.ts):
 * the harness's compact stashes reach Module A's writers
 * (platform/decision-outcome-labels.ts) as real DecisionStash objects, the
 * rows carry Module A's question / actual shapes, and nothing throws.
 * recordDecisionOutcome is mocked; reconstructDecision is the real one, so
 * the stash contract is exercised end to end.
 */
// The real gate module's import graph reaches logger → env (process.exit without an env) — the same three mocks Module A's own suites use.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy', UX_TTFT: 'ux_ttft' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/decision-gate'),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));

import {
  decisionFromStash, labelComputePolicyEscalated, labelDraftsAgree, labelRevisionMaterial, ESCALATED_LABEL_WINDOW_MS, REASK_LABEL_WINDOW_MS,
  labelComputePolicyFacts, labelComputePolicyReask, labelComputePolicyThumbs, labelRevisionMaterialFromMetadata,
  factsFromDepthMetadata, computeDecisionFromMetadata, revisionDecisionFromMetadata,
  draftsAgreeLabelMaterial, draftsAgreeMeta, draftsAgreeDecisionFromMetadata, labelDraftsAgreeFromMetadata,
} from './compute-policy-labels';
import { COMPUTE_POLICY_ESCALATION_WINDOW_MS, COMPUTE_POLICY_REASK_WINDOW_MS } from '../platform/decision-outcome-labels';

beforeEach(() => mockRecord.mockReset());

const depthAnswers = { depth: { type: 'choice', choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9 } }, research_request: { type: 'noul', noul: 0.1 } };

describe('decisionFromStash', () => {
  it('rebuilds a compute_policy DecisionStash from the compact metadata.depth.decision stash; null when unusable', () => {
    expect(decisionFromStash({ id: 'd1', answers: depthAnswers, mode: 'act' })).toMatchObject({ id: 'd1', mode: 'act', purpose: 'compute_policy' });
    expect(decisionFromStash({ id: 'd1', answers: depthAnswers })!.mode).toBe('shadow');
    expect(decisionFromStash({ id: 'd1', purpose: 'drafts_agree', mode: 'shadow', backend: 'jev', answers: { agree: { type: 'noul', noul: 0.9 } }, decidedAt: 'x' })).toMatchObject({ purpose: 'drafts_agree', backend: 'jev' });
    expect(decisionFromStash(null)).toBeNull();
    expect(decisionFromStash({ answers: {} })).toBeNull();
    expect(decisionFromStash({ id: 'd1' })).toBeNull();
  });
  it('the window constant is Module A\'s', () => {
    expect(ESCALATED_LABEL_WINDOW_MS).toBe(COMPUTE_POLICY_ESCALATION_WINDOW_MS);
    expect(ESCALATED_LABEL_WINDOW_MS).toBe(30 * 60_000);
  });
});

describe('labelComputePolicyEscalated — the primary label (a Dig deeper tap ≤ 30 min)', () => {
  const stash = { id: 'dec-cp', answers: depthAnswers, mode: 'shadow' };
  it('writes the depth row (actual = the bumped depth, label escalated) inside the window — and NO research_request row: the rung is the server\'s (forced), not the user\'s wish (audit 2026-09-26)', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - 5 * 60_000), rung: 'verify', sessionId: 'c1', now })).toBe('escalated');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'dec-cp', mode: 'shadow', purpose: 'compute_policy' });
    expect(purpose).toBe('compute_policy');
    // no facts ⇒ the tap bumps the depth to 'ordinary' (no checker ran); never a boolean on a choice question
    expect(outcome).toMatchObject({ question: 'depth', actual: 'ordinary', acted: false, label: 'escalated', sessionId: 'c1', extra: { escalated: true, escalatedTo: 'verify', rungChoice: 'forced', source: 'dig_deeper' } });
    expect(String(outcome.note)).toContain('src:dig_deeper');
    expect(String(outcome.note)).toContain('(forced rung)');
  });
  it('with the persisted facts (a checker ran) the tap bumps to contestable — the same derivation the finalize row used', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const facts = { leadToolCalls: 2, webToolCalls: 1, finalChars: 900, checkerSpawned: true, checkerMerged: true };
    labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - 60_000), rung: 'verify', now, facts });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'contestable', label: 'escalated', extra: { checkerSpawned: true, checkerMerged: true, leadToolCalls: 2 } });
  });
  it('a FORCED tap to research (an L2 row — the server\'s next rung) bumps the depth but writes NO research_request row; a CHOSEN research rung labels it true; COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG=1 restores the pre-audit label', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - 60_000), rung: 'research', now });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'contestable', extra: { escalatedTo: 'research', rungChoice: 'forced' } });
    mockRecord.mockReset();
    labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - 60_000), rung: 'research', now, rungChoice: 'chosen' });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'contestable', extra: { rungChoice: 'chosen' } });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'research_request', actual: true, label: 'escalated', extra: { rungChoice: 'chosen' } });
    mockRecord.mockReset();
    process.env.COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG = '1';
    try {
      labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - 60_000), rung: 'research', now });
      expect(mockRecord).toHaveBeenCalledTimes(2);
      expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'research_request', actual: true, extra: { rungChoice: 'forced' } });
    } finally { delete process.env.COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG; }
  });
  it('outside the window a tap writes the SECONDARY escalated_late row (never the primary — Module A refuses a premature escalated:false and the fit ignores the late label); an unknown post time writes nothing', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(now.getTime() - ESCALATED_LABEL_WINDOW_MS - 1), rung: 'research', now, sessionId: 'c1' })).toBe('escalated_late');
    expect(mockRecord).toHaveBeenCalledTimes(1); // the depth row only — research_request is labelled on the PRIMARY escalated row
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'contestable', label: 'escalated_late', extra: { escalated: true, escalatedTo: 'research', source: 'dig_deeper_late' } });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('late tap');
    mockRecord.mockReset();
    expect(labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: undefined, rung: 'research', now })).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it('no stash (preset turn) ⇒ nothing written, false; a throwing recorder is swallowed', () => {
    expect(labelComputePolicyEscalated({ decisionStash: undefined, messageCreatedAt: new Date(), rung: 'verify' })).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
    mockRecord.mockImplementation(() => { throw new Error('boom'); });
    expect(() => labelComputePolicyEscalated({ decisionStash: stash, messageCreatedAt: new Date(), rung: 'verify' })).not.toThrow();
  });
});

describe('labelDraftsAgree / labelRevisionMaterial', () => {
  it('drafts_agree: actual = the reconcile changed NO material claim; acted rides through', () => {
    expect(labelDraftsAgree({ decisionId: 'da1', p: 0.9, mode: 'shadow', material: false, changed: [], acted: false, sessionId: 'c1' })).toBe(true);
    expect(mockRecord.mock.calls[0][1]).toBe('drafts_agree');
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'da1', purpose: 'drafts_agree', answers: { agree: { type: 'noul', noul: 0.9 } } });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'agree', actual: true, acted: false, sessionId: 'c1' });
    labelDraftsAgree({ decisionId: 'da2', p: 0.9, mode: 'act', material: true, changed: ['number: 3'], acted: true });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: false, acted: true, extra: { material: true } });
    expect(String(mockRecord.mock.calls[1][2].note)).toContain('number: 3');
    expect(labelDraftsAgree({ decisionId: undefined, p: 0.9, mode: 'shadow', material: false, changed: [], acted: false })).toBe(false);
    expect(labelDraftsAgree({ decisionId: 'x', p: null, mode: 'shadow', material: false, changed: [], acted: false })).toBe(false);
  });
  it('drafts_agree: material null (the verdict says nothing about agreement) ⇒ actual null, no agreed — the row still writes', () => {
    expect(labelDraftsAgree({ decisionId: 'da4', p: 0.9, mode: 'shadow', material: null, changed: [], acted: false, label: 'reconcile', source: 'late_check' })).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'agree', actual: null, acted: false, label: 'reconcile', extra: { site: 'drafts_agree', source: 'late_check' } });
    expect(mockRecord.mock.calls[0][2].extra).not.toHaveProperty('material');
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('src:late_check');
  });
  it('drafts_agree: a full stash from the gate (backend, calibration) is used as-is', () => {
    const stash = { id: 'da3', purpose: 'drafts_agree' as const, mode: 'shadow' as const, backend: 'jev', answers: { agree: { type: 'noul' as const, noul: 0.7 } }, decidedAt: 'x', calibrated: true };
    labelDraftsAgree({ decisionId: 'da3', p: 0.7, mode: 'shadow', material: false, changed: [], acted: false, stash });
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'da3', backend: 'jev', calibrated: true });
  });
  it('revision_material: thumbs_up ⇒ the revision settled it (actual false); thumbs_down / escalation ⇒ material (actual true)', () => {
    labelRevisionMaterial({ decisionId: 'rm1', p: 0.2, mode: 'shadow', signal: 'thumbs_up' });
    labelRevisionMaterial({ decisionId: 'rm1', p: 0.2, mode: 'shadow', signal: 'escalated' });
    labelRevisionMaterial({ decisionId: 'rm1', p: 0.2, mode: 'shadow', signal: 'thumbs_down' });
    expect(mockRecord.mock.calls[0][1]).toBe('revision_material');
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'rm1', purpose: 'revision_material', answers: { material: { type: 'noul', noul: 0.2 } } });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'material', actual: false, extra: { thumbsDown: false, escalated: false } });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: true, extra: { escalated: true } });
    expect(mockRecord.mock.calls[2][2]).toMatchObject({ actual: true, extra: { thumbsDown: true } });
    expect(labelRevisionMaterial({ decisionId: undefined, p: 0.2, mode: 'shadow', signal: 'thumbs_up' })).toBe(false);
  });
});

// ── drafts_agree label semantics (2026-09-26): the verdict-read label, the acted stash, the later signals ──

describe('draftsAgreeLabelMaterial — what the SHADOW label measures (agreement, not "any change")', () => {
  it('unchanged (the reconcile echoed the answer) ⇒ agree; a fallback verdict ⇒ null (no label); a gate verdict ⇒ its material', () => {
    expect(draftsAgreeLabelMaterial({ outcome: 'unchanged' })).toBe(false);
    expect(draftsAgreeLabelMaterial({ outcome: 'revised', verdict: { material: true, changed: [], source: 'fallback' } })).toBeNull();
    expect(draftsAgreeLabelMaterial({ outcome: 'addendum', verdict: { material: true, changed: [], source: 'fallback' } })).toBeNull();
    expect(draftsAgreeLabelMaterial({ outcome: 'revised' })).toBeNull();
    expect(draftsAgreeLabelMaterial({ outcome: 'unchanged', verdict: { material: false, changed: [], source: 'gate' } })).toBe(false);
    expect(draftsAgreeLabelMaterial({ outcome: 'revised', verdict: { material: true, changed: [], source: 'gate' } })).toBe(true);
  });
  it('a diff verdict reads DIRECTION-AWARE: additions-only (contradicts false) ⇒ agree; a replaced claim ⇒ disagree; an old verdict shape without `contradicts` keeps `material`', () => {
    expect(draftsAgreeLabelMaterial({ outcome: 'revised', verdict: { material: true, changed: ['number: +$20'], source: 'diff', contradicts: false } })).toBe(false);
    expect(draftsAgreeLabelMaterial({ outcome: 'revised', verdict: { material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true } })).toBe(true);
    expect(draftsAgreeLabelMaterial({ outcome: 'revised', verdict: { material: true, changed: ['number: 3'], source: 'diff' } })).toBe(true);
  });
});

describe('draftsAgreeMeta / draftsAgreeDecisionFromMetadata / labelDraftsAgreeFromMetadata — the ACTED path', () => {
  const gateStash = { id: 'da-act', purpose: 'drafts_agree' as const, mode: 'act' as const, backend: 'TypeSafe Jev', answers: { agree: { type: 'noul' as const, noul: 0.92 } }, decidedAt: '2026-09-26T20:00:00Z', calibrated: true, challengers: [{ ok: true, answers: {} }] };
  it('an acted decision persists a COMPACT stash (challengers dropped) under metadata.check.draftsAgree; a non-acted / off / stash-less decision persists nothing', () => {
    const meta = draftsAgreeMeta({ decisionId: 'da-act', p: 0.92, mode: 'act', stash: gateStash as any }, true);
    expect(meta.draftsAgree).toEqual({ decisionId: 'da-act', p: 0.92, mode: 'act', acted: true, decision: { id: 'da-act', purpose: 'drafts_agree', mode: 'act', backend: 'TypeSafe Jev', answers: { agree: { type: 'noul', noul: 0.92 } }, decidedAt: '2026-09-26T20:00:00Z', calibrated: true } });
    // no full stash: rebuilt from decisionId + p (the noul the acted skip used)
    expect(draftsAgreeMeta({ decisionId: 'da-2', p: 0.85, mode: 'act' }, true).draftsAgree).toMatchObject({ decisionId: 'da-2', p: 0.85, acted: true, decision: { id: 'da-2', purpose: 'drafts_agree', answers: { agree: { type: 'noul', noul: 0.85 } } } });
    expect(draftsAgreeMeta({ decisionId: 'da-act', p: 0.92, mode: 'act', stash: gateStash as any }, false)).toEqual({});
    expect(draftsAgreeMeta(null, true)).toEqual({});
    expect(draftsAgreeMeta({ decisionId: undefined, p: 0.9, mode: 'act' }, true)).toEqual({});
    expect(draftsAgreeMeta({ decisionId: 'x', p: null, mode: 'act' }, true)).toEqual({});
  });
  it('the reader accepts only an acted row of the drafts_agree purpose with a noul', () => {
    const { draftsAgree } = draftsAgreeMeta({ decisionId: 'da-act', p: 0.92, mode: 'act', stash: gateStash as any }, true);
    expect(draftsAgreeDecisionFromMetadata({ check: { state: 'checked', draftsAgree } })).toMatchObject({ p: 0.92, stash: { id: 'da-act', purpose: 'drafts_agree', mode: 'act' } });
    expect(draftsAgreeDecisionFromMetadata({ check: { state: 'checked', draftsAgree: { ...draftsAgree, acted: false } } })).toBeNull();
    expect(draftsAgreeDecisionFromMetadata({ check: { state: 'checked', draftsAgree: { ...draftsAgree, decision: { ...(draftsAgree as any).decision, purpose: 'revision_material' } } } })).toBeNull();
    expect(draftsAgreeDecisionFromMetadata({ check: { state: 'checked' } })).toBeNull();
    expect(draftsAgreeDecisionFromMetadata(null)).toBeNull();
  });
  it('a later thumbs-down / Dig-deeper tap on the acted row ⇒ actual false, acted:true (the skipped reconcile mattered); thumbs-up / window_closed ⇒ actual true; every row is stamped with its signal label + source', () => {
    const metadata = { check: { state: 'checked', ...draftsAgreeMeta({ decisionId: 'da-act', p: 0.92, mode: 'act', stash: gateStash as any }, true) } };
    expect(labelDraftsAgreeFromMetadata(metadata, 'thumbs_down', 'chat-1')).toBe(true);
    expect(labelDraftsAgreeFromMetadata(metadata, 'escalated', 'chat-1')).toBe(true);
    expect(labelDraftsAgreeFromMetadata(metadata, 'thumbs_up', 'chat-1')).toBe(true);
    expect(labelDraftsAgreeFromMetadata(metadata, 'window_closed', 'chat-1')).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(4);
    for (const c of mockRecord.mock.calls) { expect(c[1]).toBe('drafts_agree'); expect(c[0]).toMatchObject({ id: 'da-act', purpose: 'drafts_agree', mode: 'act', backend: 'TypeSafe Jev', calibrated: true }); }
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'agree', actual: false, acted: true, sessionId: 'chat-1', label: 'thumbs_down', extra: { source: 'feedback', material: true } });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: false, acted: true, label: 'escalated', extra: { source: 'dig_deeper' } });
    expect(mockRecord.mock.calls[2][2]).toMatchObject({ actual: true, acted: true, label: 'thumbs_up', extra: { source: 'feedback', material: false } });
    expect(mockRecord.mock.calls[3][2]).toMatchObject({ actual: true, acted: true, label: 'window_closed', extra: { source: 'window_close' } });
  });
  it('refusals: a non-acted row (the shadow reconcile already labelled it), no draftsAgree — nothing written, false', () => {
    const metadata = { check: { state: 'checked', ...draftsAgreeMeta({ decisionId: 'da-act', p: 0.92, mode: 'act', stash: gateStash as any }, true) } };
    expect(labelDraftsAgreeFromMetadata({ check: { state: 'checked', draftsAgree: { ...(metadata.check as any).draftsAgree, acted: false } } }, 'thumbs_down')).toBe(false);
    expect(labelDraftsAgreeFromMetadata({ check: { state: 'checked' } }, 'thumbs_down')).toBe(false);
    expect(labelDraftsAgreeFromMetadata(undefined, 'thumbs_down')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ── cp/labels (2026-09-26): the finalize facts row, reask_5m, thumbs, the metadata readers ──
describe('labelComputePolicyFacts — the finalize row (never escalated)', () => {
  const stash = { id: 'dec-facts', answers: depthAnswers, mode: 'shadow' };
  const facts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: false, checkerMerged: false };
  it('writes ONE depth row with label facts, source finalize, the five facts + ttft / completion / spend / council in extra; the depth actual is the base derivation (short + no tools ⇒ simple_lookup)', () => {
    expect(labelComputePolicyFacts({ decisionStash: stash, facts, requestedPreset: 'single_thinking', turn: { ttftMs: 1234.6, completionMs: 5000, spentUsd: 0.0123456, council: 'none', checkState: 'skipped' }, acted: false, sessionId: 'c1' })).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'dec-facts', purpose: 'compute_policy' });
    expect(purpose).toBe('compute_policy');
    expect(outcome).toMatchObject({ question: 'depth', actual: 'simple_lookup', acted: false, label: 'facts', sessionId: 'c1' });
    expect(outcome.extra).toEqual({
      site: 'compute_policy', source: 'finalize',
      leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: false, checkerMerged: false,
      requestedPreset: 'single_thinking', ttftMs: 1235, completionMs: 5000, spentUsd: 0.0123, council: 'none',
    });
    expect(Object.keys(outcome.extra)).toHaveLength(12); // recordDecisionOutcome keeps the first 12 — every key survives
    expect(String(outcome.note)).toContain('facts src:finalize');
    expect(String(outcome.note)).toContain('check:skipped');
  });
  it('acted rides through (a gate_act plan); a failed finalize evidences nothing (actual null); no stash ⇒ false', () => {
    labelComputePolicyFacts({ decisionStash: stash, facts, acted: true });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ label: 'facts', acted: true });
    mockRecord.mockReset();
    labelComputePolicyFacts({ decisionStash: stash, facts, failed: true });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ label: 'facts', actual: null });
    mockRecord.mockReset();
    expect(labelComputePolicyFacts({ decisionStash: { id: 'x' }, facts })).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('labelComputePolicyReask / labelComputePolicyThumbs — the later user signals', () => {
  const stash = { id: 'dec-late', answers: depthAnswers, mode: 'shadow' };
  it('reask_5m: reasked:true bumps the base depth (ordinary without a checker, contestable with one); source reask', () => {
    expect(labelComputePolicyReask({ decisionStash: stash, facts: { leadToolCalls: 0, webToolCalls: 0, finalChars: 200, checkerSpawned: false, checkerMerged: false }, sessionId: 'c1', gapMs: 60_000 })).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'ordinary', label: 'reask_5m', extra: { source: 'reask' } });
    mockRecord.mockReset();
    labelComputePolicyReask({ decisionStash: stash, facts: { leadToolCalls: 3, webToolCalls: 2, finalChars: 2000, checkerSpawned: true, checkerMerged: true } });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'contestable', label: 'reask_5m' });
    expect(REASK_LABEL_WINDOW_MS).toBe(COMPUTE_POLICY_REASK_WINDOW_MS);
  });
  it('thumbs: a thumbs-down "wrong" bumps; a thumbs-down "slow" and a thumbs-up keep the base depth; source feedback', () => {
    const facts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 200, checkerSpawned: false, checkerMerged: false };
    labelComputePolicyThumbs({ decisionStash: stash, facts, thumbs: 'down', reason: 'wrong', sessionId: 'c1' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'ordinary', label: 'thumbs', sessionId: 'c1', extra: { source: 'feedback' } });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('thumbs:down/wrong');
    mockRecord.mockReset();
    labelComputePolicyThumbs({ decisionStash: stash, facts, thumbs: 'down', reason: 'slow' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'simple_lookup', label: 'thumbs' });
    mockRecord.mockReset();
    labelComputePolicyThumbs({ decisionStash: stash, facts, thumbs: 'up' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'simple_lookup', label: 'thumbs' });
  });
});

describe('metadata readers — what a persisted assistant row gives the later labels', () => {
  const persisted = {
    depth: { plan: { preset: 'thinking' }, decision: { id: 'dec-row', answers: depthAnswers, mode: 'shadow' }, facts: { leadToolCalls: 1, webToolCalls: 1, finalChars: 800, checkerSpawned: true, checkerMerged: false } },
    check: { state: 'updated', changed: ['number: 3'], verdict: { material: true, source: 'gate', decisionId: 'rm-row', decision: { id: 'rm-row', purpose: 'revision_material', mode: 'shadow', backend: 'jev', answers: { material: { type: 'noul', noul: 0.3 } }, decidedAt: 'x' } } },
  };
  it('factsFromDepthMetadata: the persisted facts, checkerMerged upgraded by a completed late check; null on a pre-cp/labels row', () => {
    expect(factsFromDepthMetadata(persisted)).toEqual({ leadToolCalls: 1, webToolCalls: 1, finalChars: 800, checkerSpawned: true, checkerMerged: true });
    expect(factsFromDepthMetadata({ depth: { facts: { leadToolCalls: 0, webToolCalls: 0, finalChars: 10, checkerSpawned: false, checkerMerged: false } }, check: { state: 'checking' } })!.checkerMerged).toBe(false);
    expect(factsFromDepthMetadata({ depth: { plan: {} } })).toBeNull();
    expect(factsFromDepthMetadata(null)).toBeNull();
  });
  it('computeDecisionFromMetadata / revisionDecisionFromMetadata rebuild the stashes; a diff-decided verdict carries none', () => {
    expect(computeDecisionFromMetadata(persisted)).toMatchObject({ id: 'dec-row', purpose: 'compute_policy', mode: 'shadow' });
    expect(revisionDecisionFromMetadata(persisted)).toMatchObject({ updated: true, stash: { id: 'rm-row', purpose: 'revision_material' } });
    expect(revisionDecisionFromMetadata({ check: { state: 'updated', verdict: { material: true, source: 'diff' } } })).toBeNull();
    expect(revisionDecisionFromMetadata({ check: { state: 'checked', verdict: persisted.check.verdict } })).toMatchObject({ updated: false, state: 'checked', acted: false });
    // acted ⇔ the GATE decided wording-only (source 'gate' + material false) — the act-only branch that withholds the rewrite.
    expect(revisionDecisionFromMetadata({ check: { state: 'checked', verdict: { ...persisted.check.verdict, material: false, source: 'gate' } } })).toMatchObject({ updated: false, state: 'checked', acted: true });
    expect(revisionDecisionFromMetadata({ check: { state: 'updated', verdict: { ...persisted.check.verdict, material: true, source: 'gate' } } })).toMatchObject({ updated: true, acted: false });
  });
  it('labelRevisionMaterialFromMetadata: thumbs-down / a tap on an UPDATED row ⇒ material true; thumbs-up ⇒ false (acted:false, pill in the note); a row without a gate decision ⇒ nothing', () => {
    expect(labelRevisionMaterialFromMetadata(persisted, 'thumbs_down', 'c1')).toBe(true);
    expect(mockRecord.mock.calls[0][1]).toBe('revision_material');
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'rm-row', purpose: 'revision_material', backend: 'jev' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'material', actual: true, acted: false, sessionId: 'c1', extra: { thumbsDown: true } });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('pill:updated');
    mockRecord.mockReset();
    labelRevisionMaterialFromMetadata(persisted, 'escalated');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: true, extra: { escalated: true } });
    mockRecord.mockReset();
    labelRevisionMaterialFromMetadata(persisted, 'thumbs_up');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: false });
    mockRecord.mockReset();
    expect(labelRevisionMaterialFromMetadata({ check: { state: 'updated', verdict: { material: true, source: 'diff' } } }, 'thumbs_down')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  // audit/revision-material-act-period-labels (2026-09-26): in act a confident wording-only verdict withholds the rewrite and the pill
  // reads 'checked' — exactly the in-band decisions. Those rows used to label nothing, so auto-demote / act-period readiness were blind.
  const checkedActed = { ...persisted, check: { state: 'checked', verdict: { ...persisted.check.verdict, material: false, source: 'gate' } } };
  it("labelRevisionMaterialFromMetadata: a 'checked' row whose GATE withheld the rewrite labels with acted:true — thumbs-down / a tap ⇒ material true (the withheld rewrite may have mattered), thumbs-up ⇒ false", () => {
    expect(labelRevisionMaterialFromMetadata(checkedActed, 'thumbs_down', 'c1')).toBe(true);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'rm-row', purpose: 'revision_material' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'material', actual: true, acted: true, sessionId: 'c1', extra: { thumbsDown: true } });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('rewrite skipped (acted)');
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('pill:checked (rewrite withheld)');
    mockRecord.mockReset();
    expect(labelRevisionMaterialFromMetadata(checkedActed, 'escalated')).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: true, acted: true, extra: { escalated: true } });
    mockRecord.mockReset();
    expect(labelRevisionMaterialFromMetadata(checkedActed, 'thumbs_up')).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: false, acted: true });
  });
  it("labelRevisionMaterialFromMetadata: a 'checked' row with a gate stash but NOT a gate wording-only verdict still labels, acted:false; an incomplete pill ('checking' / 'interrupted') labels nothing", () => {
    // (Defensive: today every 'checked' row that carries a stash is the gate's withheld rewrite; a shadow stash rides only 'updated' rows.)
    expect(labelRevisionMaterialFromMetadata({ ...persisted, check: { ...persisted.check, state: 'checked' } }, 'thumbs_down')).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: true, acted: false });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('pill:checked');
    expect(String(mockRecord.mock.calls[0][2].note)).not.toContain('withheld');
    mockRecord.mockReset();
    expect(labelRevisionMaterialFromMetadata({ ...checkedActed, check: { ...checkedActed.check, state: 'interrupted' } }, 'thumbs_down')).toBe(false);
    expect(labelRevisionMaterialFromMetadata({ ...checkedActed, check: { ...checkedActed.check, state: 'checking' } }, 'thumbs_down')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('audit 2026-09-26 — acted taps, guest / segment stamps, the checker effort actually sent', () => {
  const depthAnswersLocal = { depth: { type: 'choice', choice: 'simple_lookup', confidence: 0.9 }, stakes: { type: 'noul', noul: 0.05 } };
  it('labelComputePolicyEscalated carries `acted` when the plan acted (telemetry-readiness-1: the tap row used to read acted:false on an acted plan) + guest / segment', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    labelComputePolicyEscalated({ decisionStash: { id: 'dec-a', answers: depthAnswersLocal, mode: 'act' }, messageCreatedAt: new Date(now.getTime() - 60_000), rung: 'verify', now, acted: true, segment: 'user' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ acted: true, extra: { escalated: true, segment: 'user', stakes: 0.05 } });
  });
  it('labelComputePolicyFacts stamps guest + segment on the row (guest-persistence-2) and factsFromDepthMetadata keeps checkerEffortSent', () => {
    labelComputePolicyFacts({ decisionStash: { id: 'dec-b', answers: depthAnswersLocal, mode: 'shadow' }, facts: { leadToolCalls: 0, webToolCalls: 0, finalChars: 100, checkerSpawned: false, checkerMerged: false }, guest: true, segment: 'guest' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ label: 'facts', extra: { guest: true, segment: 'guest' } });
    expect(factsFromDepthMetadata({ depth: { facts: { leadToolCalls: 1, webToolCalls: 1, finalChars: 10, checkerSpawned: true, checkerMerged: false, checkerEffortSent: 'max' } }, check: { state: 'updated' } })).toEqual({ leadToolCalls: 1, webToolCalls: 1, finalChars: 10, checkerSpawned: true, checkerMerged: true, checkerEffortSent: 'max' });
  });
});
describe('2026-09-26 (audit) — segment recovery from the compact stash + the unescalatable facts tag', () => {
  const facts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 300, checkerSpawned: false, checkerMerged: false };

  it('decisionFromStash recovers the segment from the compact metadata.depth.decision (garbage dropped; absent stays absent)', () => {
    expect(decisionFromStash({ id: 'd1', answers: depthAnswers, mode: 'shadow', segment: 'supervisor' })).toMatchObject({ id: 'd1', segment: 'supervisor' });
    expect(decisionFromStash({ id: 'd1', answers: depthAnswers, mode: 'shadow', segment: 'weird' })).not.toHaveProperty('segment');
    expect(decisionFromStash({ id: 'd1', answers: depthAnswers, mode: 'shadow' })).not.toHaveProperty('segment');
    expect(computeDecisionFromMetadata({ depth: { decision: { id: 'd2', answers: depthAnswers, mode: 'shadow', segment: 'machine' } } })).toMatchObject({ id: 'd2', segment: 'machine' });
  });

  it('labelComputePolicyFacts escalatable:false ⇒ excludeFromFit on the outcome (no chip ⇒ no escalated:true can ever pair with it); true / unset ⇒ untagged', () => {
    const stash = { id: 'dec-sup', answers: depthAnswers, mode: 'shadow', segment: 'supervisor' };
    expect(labelComputePolicyFacts({ decisionStash: stash, facts, escalatable: false })).toBe(true);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'dec-sup', segment: 'supervisor' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ label: 'facts', excludeFromFit: true });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('no chip (excluded from fit)');
    mockRecord.mockReset();
    labelComputePolicyFacts({ decisionStash: stash, facts, escalatable: true });
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeFalsy();
    mockRecord.mockReset();
    labelComputePolicyFacts({ decisionStash: stash, facts });
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeFalsy();
  });
});
