/**
 * self-audit-gate.ts — the gate decision (unchanged act/skip contract) and the
 * WI-C (2026-09-25) deferred outcome: a shadow decision whose audit RAN is
 * stashed and labelled after the round from whether it reopened a completed
 * step; the kill switch restores the decision-time actual:null row.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockDecide = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockDecisionMode = jest.fn((): 'off' | 'shadow' | 'act' => 'shadow');
const mockRecordDecisionOutcome = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/decision-gate')),
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockDecisionMode(),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));

import {
  SELF_AUDIT_STEP_NOULS_DEFAULT, UNEVIDENCED_QUESTION, completedStepIds, recordSelfAuditOutcome, recordSelfAuditStepOutcomes, reviewedStepIds,
  selfAuditGateDecide, selfAuditGateRequest, selfAuditGateSkips, selfAuditQuestionsV2, selfAuditReopened, labelSelfAuditOutcome,
  selfAuditStepNoulCap, selfAuditV2WouldSkip,
} from './self-audit-gate';

// E2 (2026-09-25): the real decide() returns the mode the answer may be USED
// under — the purpose's mode on a calibrated backend, 'shadow' otherwise — and
// the consumer keys its act branch on THAT field, so the stub mirrors it.
const answer = (noul: number, mode: 'shadow' | 'act' = mockDecisionMode() === 'act' ? 'act' : 'shadow') =>
  ({ id: 'sa1', mode, backend: 'TypeSafe Jev', ms: 5, calibrated: true, answers: { unevidenced: { type: 'noul', noul } } });
const input = () => ({
  plan: { steps: [{ id: 1, status: 'completed', text: 'ship it' }, { id: 2, status: 'blocked', text: 'wait' }], acceptanceCriteria: ['green CI'] },
  finalText: 'Pushed and merged.',
  receipts: [],
  sessionId: 's1',
});
beforeEach(() => {
  jest.clearAllMocks();
  mockDecide.mockResolvedValue(null);
  mockDecisionMode.mockReturnValue('shadow');
});

describe('selfAuditGateDecide', () => {
  it('off → no call, no skip, no stash', async () => {
    mockDecisionMode.mockReturnValue('off');
    expect(await selfAuditGateDecide(input())).toEqual({ skip: false, stash: null });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('shadow + an answer → audit runs, NO outcome row yet, the stash carries the decision for the post-audit label', async () => {
    mockDecide.mockResolvedValue(answer(0.1));
    const d = await selfAuditGateDecide(input());
    expect(d.skip).toBe(false);
    expect(d.stash).toMatchObject({ id: 'sa1', purpose: 'self_audit', mode: 'shadow', backend: 'TypeSafe Jev', answers: { unevidenced: { type: 'noul', noul: 0.1 } } });
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'self_audit', sessionId: 's1' });
  });

  it('act + confident "evidenced" → skip, outcome recorded acted:true immediately (unchanged), no stash', async () => {
    mockDecisionMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer(0.1));
    const d = await selfAuditGateDecide(input());
    expect(d).toEqual({ skip: true, stash: null });
    expect(mockRecordDecisionOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'sa1' }), 'self_audit', expect.objectContaining({ question: 'unevidenced', actual: null, acted: true, note: 'audit skipped' }));
  });

  it('act + not confident → audit runs with a stash (labelled later)', async () => {
    mockDecisionMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer(0.5));
    const d = await selfAuditGateDecide(input());
    expect(d.skip).toBe(false);
    expect(d.stash?.id).toBe('sa1');
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });

  it('E2: act purpose but the answer came back as SHADOW (uncalibrated backend) → the audit runs, never skipped', async () => {
    mockDecisionMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ ...answer(0.05, 'shadow'), calibrated: false });
    const d = await selfAuditGateDecide(input());
    expect(d.skip).toBe(false);
    expect(d.stash).toMatchObject({ id: 'sa1', mode: 'shadow' });
    expect(await selfAuditGateSkips(input())).toBe(false);
  });

  it('null answer / thrown decide → fail open (audit runs, nothing recorded); the legacy boolean wrapper mirrors skip', async () => {
    expect(await selfAuditGateDecide(input())).toEqual({ skip: false, stash: null });
    mockDecide.mockRejectedValue(new Error('down'));
    expect(await selfAuditGateDecide(input())).toEqual({ skip: false, stash: null });
    expect(await selfAuditGateSkips(input())).toBe(false);
    mockDecisionMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer(0.05));
    expect(await selfAuditGateSkips(input())).toBe(true);
  });
});

describe('the post-audit label', () => {
  it('completedStepIds / selfAuditReopened: a completed step that is no longer completed after the round = reopened', () => {
    const before = completedStepIds([{ id: 1, status: 'completed' }, { id: 2, status: 'blocked' }, { id: 3, status: 'completed' }]);
    expect(before).toEqual(['1', '3']);
    expect(selfAuditReopened(before, [{ id: 1, status: 'completed' }, { id: 2, status: 'blocked' }, { id: 3, status: 'completed' }])).toBe(false);
    expect(selfAuditReopened(before, [{ id: 1, status: 'in_progress' }, { id: 2, status: 'blocked' }, { id: 3, status: 'completed' }])).toBe(true);
    expect(selfAuditReopened(before, [{ id: 1, status: 'completed' }, { id: 3, status: 'blocked' }])).toBe(true);
    expect(selfAuditReopened(before, [{ id: 3, status: 'completed' }])).toBe(true); // step 1 withdrawn
    expect(selfAuditReopened([], [{ id: 1, status: 'pending' }])).toBe(false);
    // A blocked step that the audit CLEARED and finished is not a reopen.
    expect(selfAuditReopened(before, [{ id: 1, status: 'completed' }, { id: 2, status: 'completed' }, { id: 3, status: 'completed' }])).toBe(false);
  });

  it('recordSelfAuditOutcome reconstructs the stash and records the labelled outcome (agreed against the stored noul)', () => {
    const stash = { id: 'sa1', purpose: 'self_audit', mode: 'shadow', backend: 'TypeSafe Jev', answers: { unevidenced: { type: 'noul', noul: 0.1 } }, decidedAt: 'now' } as any;
    recordSelfAuditOutcome(stash, true, 's1', 'audit ran: reopened a completed step');
    expect(mockRecordDecisionOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'sa1', mode: 'shadow', backend: 'TypeSafe Jev' }), 'self_audit', { question: 'unevidenced', actual: true, acted: false, sessionId: 's1', note: 'audit ran: reopened a completed step' });
    recordSelfAuditOutcome(null, false, 's1', 'x');
    expect(mockRecordDecisionOutcome).toHaveBeenLastCalledWith(null, 'self_audit', expect.anything());
  });
});

// E5 (2026-09-25): the composite label — the reopen-only label had 0/9 prod agreement.
describe('labelSelfAuditOutcome (composite)', () => {
  it('OR of reopened / guard strike / reject-back; components ride the note', () => {
    expect(labelSelfAuditOutcome({ reopened: false, rejectBacksAfter: 0, guardStrikesAfter: 0, completedBefore: 3 }))
      .toEqual({ actual: false, note: 'audit ran: no completed step reopened; reopened=false guard_strike=0 reject_back=0 (3 completed before)' });
    expect(labelSelfAuditOutcome({ reopened: true, rejectBacksAfter: 0, guardStrikesAfter: 0, completedBefore: 3 }).actual).toBe(true);
    const struck = labelSelfAuditOutcome({ reopened: false, rejectBacksAfter: 0, guardStrikesAfter: 1, completedBefore: 3 });
    expect(struck.actual).toBe(true);
    expect(struck.note).toContain('guard_strike=1');
    const rejected = labelSelfAuditOutcome({ reopened: false, rejectBacksAfter: 2, guardStrikesAfter: 0, completedBefore: 0 });
    expect(rejected.actual).toBe(true);
    expect(rejected.note).toContain('reject_back=2');
  });

  it('plan unreadable: null only when NO other signal was observed; a strike still labels true', () => {
    expect(labelSelfAuditOutcome({ reopened: null, rejectBacksAfter: 0, guardStrikesAfter: 0, completedBefore: 2 }))
      .toEqual({ actual: null, note: 'audit ran: plan unreadable; reopened=unknown guard_strike=0 reject_back=0 (2 completed before)' });
    expect(labelSelfAuditOutcome({ reopened: null, rejectBacksAfter: 1, guardStrikesAfter: 0, completedBefore: 2 }).actual).toBe(true);
  });
});

/* E8 (2026-09-25): the re-posed request — receipt heads, the split nouls, the
 * per-step nouls built in code by POSITION, the stricter act AND, and the
 * per-question labels. */
describe('E8 re-posed request', () => {
  const ENV = ['DECISION_GATE_SELF_AUDIT_STEP_NOULS'];
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

  const receipt = (over: Partial<any> = {}): any => ({
    id: 'r1234567890', chatId: 's1', runId: 'run1', tool: 'git_push', ok: true, ids: { branch: 'b', sha: 'abc1234' },
    inputHash: 'h', outputHash: 'h', createdAt: new Date('2026-09-25T00:00:00Z'), argsHead: '{"branch":"b"}', resultHead: 'Pushed b to GitHub — sha abc1234', ...over,
  });
  const plan = () => ({
    steps: [
      { id: 1, status: 'completed', text: 'push the branch' },
      { id: 2, status: 'blocked', text: 'wait for CI', note: 'external' },
      { id: 3, status: 'completed', text: 'open the PR' },
      { id: 4, status: 'pending', text: 'merge' },
    ],
    acceptanceCriteria: ['green CI'],
  });
  const v2Input = () => ({ plan: plan(), finalText: 'Pushed and opened PR #7.', receipts: [receipt(), receipt({ id: 'r2', tool: 'open_pull_request', ok: false, ids: {}, resultHead: 'open_pull_request failed: 422', argsHead: undefined })], sessionId: 's1' });

  it('v2 (default): objects, the reviewed completed steps by position, receipts with scrubbed heads, the final LAST; questions = holistic + split + one per reviewed step', () => {
    const r = selfAuditGateRequest(v2Input());
    expect(r.shape).toBe('v2');
    const keys = Object.keys(r.state);
    expect(keys[keys.length - 1]).toBe('final_summary');
    expect(r.state).toMatchObject({
      plan_steps: [
        { id: '1', status: 'completed', text: 'push the branch' },
        { id: '2', status: 'blocked', text: 'wait for CI', note: 'external' },
        { id: '3', status: 'completed', text: 'open the PR' },
        { id: '4', status: 'pending', text: 'merge' },
      ],
      acceptance_criteria: ['green CI'],
      completed_steps_under_review: [{ position: 1, id: '1', text: 'push the branch' }, { position: 2, id: '3', text: 'open the PR' }],
      receipts: [
        { id: 'r1234567', tool: 'git_push', ok: true, ids: { branch: 'b', sha: 'abc1234' }, args: '{"branch":"b"}', result: 'Pushed b to GitHub — sha abc1234' },
        { id: 'r2', tool: 'open_pull_request', ok: false, ids: {}, args: null, result: 'open_pull_request failed: 422' },
      ],
      final_summary: 'Pushed and opened PR #7.',
    });
    expect(Object.keys(r.questions)).toEqual(['unevidenced', 'claims_unbacked', 'steps_unbacked', 'step_1_evidenced', 'step_2_evidenced']);
    expect(r.questions.unevidenced).toEqual(UNEVIDENCED_QUESTION);
    expect((r.questions.step_2_evidenced as any).instructions).toContain('position 2 of `completed_steps_under_review`');
    expect((r.questions.step_2_evidenced as any).instructions).not.toContain('open the PR'); // by position, never the text — the questionsHash depends on the count only
    expect(selfAuditQuestionsV2(2)).toEqual(selfAuditQuestionsV2(2));
    expect(reviewedStepIds(plan().steps)).toEqual(['1', '3']);
  });

  it('DECISION_GATE_SELF_AUDIT_STEP_NOULS caps the per-step fan-out (0 = split only; clamped 0–40; default 12)', () => {
    expect(selfAuditStepNoulCap()).toBe(SELF_AUDIT_STEP_NOULS_DEFAULT);
    process.env.DECISION_GATE_SELF_AUDIT_STEP_NOULS = '1';
    const one = selfAuditGateRequest(v2Input());
    expect(Object.keys(one.questions)).toEqual(['unevidenced', 'claims_unbacked', 'steps_unbacked', 'step_1_evidenced']);
    expect(one.state.completed_steps_under_review).toEqual([{ position: 1, id: '1', text: 'push the branch' }]);
    process.env.DECISION_GATE_SELF_AUDIT_STEP_NOULS = '0';
    expect(Object.keys(selfAuditGateRequest(v2Input()).questions)).toEqual(['unevidenced', 'claims_unbacked', 'steps_unbacked']);
    process.env.DECISION_GATE_SELF_AUDIT_STEP_NOULS = '99';
    expect(selfAuditStepNoulCap()).toBe(40);
    process.env.DECISION_GATE_SELF_AUDIT_STEP_NOULS = '-3';
    expect(selfAuditStepNoulCap()).toBe(0);
  });

  it('selfAuditV2WouldSkip: every per-step noul ≥ τ AND both split nouls ≤ 1−τ; null for a v1 answer set', () => {
    const a = (over: Record<string, number>) => Object.fromEntries(Object.entries({ unevidenced: 0.1, claims_unbacked: 0.05, steps_unbacked: 0.05, step_1_evidenced: 0.95, step_2_evidenced: 0.9, ...over }).map(([k, v]) => [k, { type: 'noul', noul: v }])) as any;
    expect(selfAuditV2WouldSkip(a({}), 0.85)).toBe(true);
    expect(selfAuditV2WouldSkip(a({ step_2_evidenced: 0.6 }), 0.85)).toBe(false);
    expect(selfAuditV2WouldSkip(a({ claims_unbacked: 0.3 }), 0.85)).toBe(false);
    expect(selfAuditV2WouldSkip(a({ steps_unbacked: 0.2 }), 0.85)).toBe(false);
    expect(selfAuditV2WouldSkip(a({ step_2_evidenced: 0.9 }), 0.95)).toBe(false);
    expect(selfAuditV2WouldSkip({ unevidenced: { type: 'noul', noul: 0.1 } }, 0.85)).toBeNull();
    expect(selfAuditV2WouldSkip(null, 0.85)).toBeNull();
  });

  it('act mode under v2 is STRICTER, never looser: a confident holistic "evidenced" with an unconfident per-step noul does not skip; all confident does (note carries the v2 readout)', async () => {
    mockDecisionMode.mockReturnValue('act');
    const answersOf = (step1: number) => ({ id: 'sa2', mode: 'act', backend: 'TypeSafe Jev', ms: 5, answers: { unevidenced: { type: 'noul', noul: 0.05 }, claims_unbacked: { type: 'noul', noul: 0.05 }, steps_unbacked: { type: 'noul', noul: 0.05 }, step_1_evidenced: { type: 'noul', noul: step1 } } });
    mockDecide.mockResolvedValue(answersOf(0.5));
    let d = await selfAuditGateDecide(v2Input());
    expect(d.skip).toBe(false);
    expect(d.stash?.id).toBe('sa2');
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
    mockDecide.mockResolvedValue(answersOf(0.97));
    d = await selfAuditGateDecide(v2Input());
    expect(d).toEqual({ skip: true, stash: null });
    expect(mockRecordDecisionOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'sa2' }), 'self_audit', expect.objectContaining({ acted: true, note: 'audit skipped; v2 would-skip:yes' }));
    // the request itself is the v2 shape
    expect(mockDecide.mock.calls[0][1]).toHaveProperty('step_1_evidenced');
    expect(mockDecide.mock.calls[0][0]).toHaveProperty('completed_steps_under_review');
  });

  it('recordSelfAuditStepOutcomes: claims ↔ composite, steps_unbacked ↔ any reviewed step reopened, step_k ↔ that step still completed (position → completedBefore[k−1]); a v1 stash records nothing', () => {
    const stash = { id: 'sa3', purpose: 'self_audit', mode: 'shadow', backend: 'TypeSafe Jev', answers: { unevidenced: { type: 'noul', noul: 0.3 }, claims_unbacked: { type: 'noul', noul: 0.2 }, steps_unbacked: { type: 'noul', noul: 0.2 }, step_1_evidenced: { type: 'noul', noul: 0.9 }, step_2_evidenced: { type: 'noul', noul: 0.8 } }, decidedAt: 'now' } as any;
    recordSelfAuditStepOutcomes(stash, ['1', '3'], [{ id: 1, status: 'completed' }, { id: 2, status: 'blocked' }, { id: 3, status: 'in_progress' }], 's1', true);
    const calls = mockRecordDecisionOutcome.mock.calls.map((c) => c[2]);
    expect(calls).toEqual([
      expect.objectContaining({ question: 'claims_unbacked', actual: true, note: 'audit ran: 1 of 2 reviewed step(s) reopened' }),
      expect.objectContaining({ question: 'steps_unbacked', actual: true }),
      expect.objectContaining({ question: 'step_1_evidenced', actual: true, note: 'audit ran: 1 of 2 reviewed step(s) reopened; step 1' }),
      expect.objectContaining({ question: 'step_2_evidenced', actual: false, note: 'audit ran: 1 of 2 reviewed step(s) reopened; step 3' }),
    ]);
    mockRecordDecisionOutcome.mockClear();
    recordSelfAuditStepOutcomes(stash, ['1', '3'], null, 's1', null); // plan unreadable → paired, unlabelled
    expect(mockRecordDecisionOutcome.mock.calls.map((c) => c[2].actual)).toEqual([null, null, null, null]);
    mockRecordDecisionOutcome.mockClear();
    recordSelfAuditStepOutcomes({ ...stash, answers: { unevidenced: { type: 'noul', noul: 0.3 } } }, ['1'], [{ id: 1, status: 'completed' }], 's1', false);
    recordSelfAuditStepOutcomes(null, [], [], 's1', false);
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });
});
