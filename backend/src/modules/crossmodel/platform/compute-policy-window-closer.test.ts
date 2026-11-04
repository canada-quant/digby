/**
 * compute_policy window closer (audit 2026-09-26 — H1). Pins:
 *   - eligibility: a human assistant row with a decision, no rung, not yet
 *     closed; supervisor chats / machine rows / deeper-findings / addendum
 *     rows / tapped rows are never candidates;
 *   - the pass writes ONE `escalated:false, windowClosed:true` row per
 *     candidate through the ONE writer, facts upgraded by the pill, `acted`
 *     from the persisted plan, actual = the PREDICTED depth when the plan
 *     acted (silence = the skip stood), and stamps windowClosedAt.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockPrisma: any = {
  $queryRaw: jest.fn(async () => []),
  crossModelMessage: { update: jest.fn(async (q: any) => q) },
  loopMetric: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  ...jest.requireActual('./decision-gate'),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));

import { runComputePolicyWindowCloserOnce, runTurnPlanWindowCloserOnce, windowCloserEligible, predictedDepthOf, machineSegmentOf, machineLabelEligible, WINDOW_CLOSER_JOB_ID } from './compute-policy-window-closer';

const NOW = new Date('2026-09-26T21:00:00Z');
const answers = { depth: { type: 'choice', choice: 'simple_lookup', confidence: 0.92, probabilities: { simple_lookup: 0.92, ordinary: 0.05, contestable: 0.02, unclear: 0.01 } }, stakes: { type: 'noul', noul: 0.05 } };
const row = (over: Record<string, any> = {}, chat: Record<string, any> = {}) => ({
  id: 'a1', chatId: 'c1', createdAt: new Date('2026-09-26T20:00:00Z'), isSupervisor: false, isProjectSupervisor: false,
  metadata: {
    mode: 'thinking', origin: 'user',
    depth: { plan: { preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, council: 'none', source: 'gate_shadow' }, decision: { id: 'd1', answers, mode: 'shadow' }, facts: { leadToolCalls: 4, webToolCalls: 2, finalChars: 3000, checkerSpawned: true, checkerMerged: false } },
    check: { state: 'updated' },
    ...over,
  },
  ...chat,
});

beforeEach(() => {
  jest.clearAllMocks();
  // The compute_policy cases run without the turn_plan pass (2026-10-03; its own describe below re-enables it).
  process.env.TURN_PLAN_LABELS_DISABLED = '1';
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.loopMetric.count.mockResolvedValue(0);
});

describe('windowCloserEligible / predictedDepthOf (pure)', () => {
  it('a human decision row with no rung is eligible; supervisor / machine / kinds / tapped / closed rows are not', () => {
    expect(windowCloserEligible(row().metadata, {})).toBe(true);
    expect(windowCloserEligible(row().metadata, { isSupervisor: true })).toBe(false);
    expect(windowCloserEligible(row({ origin: 'schedule' }).metadata, {})).toBe(false);
    expect(windowCloserEligible(row({ kind: 'deeper_findings' }).metadata, {})).toBe(false);
    expect(windowCloserEligible(row({ kind: 'check_addendum' }).metadata, {})).toBe(false);
    expect(windowCloserEligible({ ...row().metadata, depth: { ...row().metadata.depth, escalations: [{ rung: 'verify', at: 't' }] } }, {})).toBe(false);
    expect(windowCloserEligible({ ...row().metadata, depth: { ...row().metadata.depth, windowClosedAt: 't' } }, {})).toBe(false);
    expect(windowCloserEligible({ depth: { plan: {} } }, {})).toBe(false);
  });
  it('predictedDepthOf reads the stash depth choice; unclear / missing ⇒ null', () => {
    expect(predictedDepthOf(row().metadata)).toBe('simple_lookup');
    expect(predictedDepthOf({ depth: { decision: { answers: { depth: { type: 'choice', choice: 'unclear' } } } } })).toBeNull();
    expect(predictedDepthOf({})).toBeNull();
  });
});

describe('runComputePolicyWindowCloserOnce', () => {
  it('writes the window-closed NEGATIVE (facts upgraded by the pill: merged), stamps windowClosedAt; a shadow plan derives the actual from the facts', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([row()]);
    const summary = await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(summary).toMatch(/closed 1, skipped 0, failed 0 of 1/);
    expect(mockRecord).toHaveBeenCalledTimes(1); // the depth row (no research_request answer on this stash ⇒ no second row)
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'd1', purpose: 'compute_policy' });
    expect(purpose).toBe('compute_policy');
    // heavy turn (4 tools, 3000 chars) whose draft merged late ('updated' pill) ⇒ contestable — the same derivation the tap uses
    expect(outcome).toMatchObject({ question: 'depth', actual: 'contestable', acted: false, label: 'escalated', sessionId: 'c1', extra: { escalated: false, windowClosed: true, source: 'window_close', checkerMerged: true, segment: 'user', stakes: 0.05 } });
    expect(String(outcome.note)).toContain('window closed');
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'a1' });
    expect(upd.data.metadata.depth.windowClosedAt).toBe(NOW.toISOString());
    expect(upd.data.metadata.depth.windowClosedReason).toBe('labelled');
    expect(upd.data.metadata.depth.facts).toEqual(row().metadata.depth.facts); // the persisted facts are not rewritten
  });
  it('an ACTED plan (gate_act) with no tap: actual = the PREDICTED depth (silence = the act stood), acted:true', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([row({ depth: { ...row().metadata.depth, plan: { ...row().metadata.depth.plan, spawnChecker: false, source: 'gate_act' } } })]);
    await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'simple_lookup', acted: true, extra: { escalated: false, windowClosed: true } });
  });
  it('ineligible rows are stamped closed (never re-scanned) but never labelled; a row without a usable stash likewise', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([row({ kind: 'deeper_findings' }), row({ depth: { plan: {}, decision: { id: 'x' } } })]);
    const summary = await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(summary).toMatch(/closed 0, skipped 2/);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.crossModelMessage.update.mock.calls.map((c: any) => c[0].data.metadata.depth.windowClosedReason)).toEqual(['ineligible', 'no_decision']);
  });
  // ── backlog DOI-21 (2026-09-28): the MACHINE / SUPERVISOR harness-proxy label ──
  it('DOI-21: a supervisor row past the window gets ONE `machine` row — actual = the harness proxy (pill updated ⇒ contestable), segment supervisor, excludeFromFit during the 30-row ramp; stamped machine_labelled', async () => {
    mockPrisma.loopMetric.count.mockResolvedValue(0);
    mockPrisma.$queryRaw.mockResolvedValueOnce([row({}, { isSupervisor: true })]).mockResolvedValue([]);
    const summary = await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(summary).toMatch(/closed 0, skipped 0, failed 0 of 1 .*machine-labelled 1/);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [, purpose, outcome] = mockRecord.mock.calls[0];
    expect(purpose).toBe('compute_policy');
    expect(outcome).toMatchObject({ question: 'depth', actual: 'contestable', acted: false, label: 'machine', excludeFromFit: true, sessionId: 'c1', extra: { source: 'window_close', segment: 'supervisor' } });
    expect(String(outcome.note)).toContain('machine proxy');
    expect(String(outcome.note)).toContain('ramp');
    expect(mockPrisma.loopMetric.count).toHaveBeenCalledTimes(1);
    expect(mockPrisma.loopMetric.count.mock.calls[0][0].where.kind).toBe('decision_gate');
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.depth.windowClosedReason).toBe('machine_labelled');
  });
  it('DOI-21: past the ramp the machine row ENTERS the fit; a machine-origin row on a plain chat is segment machine; no pill + 1 tool call ⇒ ordinary; the count query failing keeps the ramp (excluded) — never a throw', async () => {
    mockPrisma.loopMetric.count.mockResolvedValue(30);
    mockPrisma.$queryRaw.mockResolvedValueOnce([row({ origin: 'schedule', check: {}, depth: { ...row().metadata.depth, facts: { leadToolCalls: 1, webToolCalls: 1, finalChars: 900, checkerSpawned: false, checkerMerged: false } } })]).mockResolvedValue([]);
    await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'ordinary', label: 'machine', extra: { segment: 'machine' } });
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeFalsy(); // past the ramp — the writer only tags true rows on the meta
    jest.clearAllMocks();
    mockPrisma.loopMetric.count.mockRejectedValue(new Error('count down'));
    mockPrisma.$queryRaw.mockResolvedValueOnce([row({}, { isSupervisor: true })]).mockResolvedValue([]);
    expect(await runComputePolicyWindowCloserOnce({ now: NOW })).toMatch(/machine-labelled 1/);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ label: 'machine', excludeFromFit: true });
  });
  it('DOI-21 pure: machineSegmentOf / machineLabelEligible — tapped, closed, addendum and human rows never qualify', () => {
    expect(machineSegmentOf(row().metadata, {})).toBeNull();
    expect(machineSegmentOf(row().metadata, { isProjectSupervisor: true })).toBe('supervisor');
    expect(machineSegmentOf(row({ origin: 'agent' }).metadata, {})).toBe('machine');
    expect(machineLabelEligible(row().metadata, {})).toBe(false);
    expect(machineLabelEligible(row().metadata, { isSupervisor: true })).toBe(true);
    expect(machineLabelEligible({ ...row().metadata, depth: { ...row().metadata.depth, escalations: [{ rung: 'verify' }] } }, { isSupervisor: true })).toBe(false);
    expect(machineLabelEligible({ ...row().metadata, depth: { ...row().metadata.depth, windowClosedAt: 't' } }, { isSupervisor: true })).toBe(false);
    expect(machineLabelEligible(row({ kind: 'check_addendum' }).metadata, { isSupervisor: true })).toBe(false);
  });
  // ── backlog E10 (2026-09-28): the revision_material HARNESS label pass ──
  it('E10: a row with a persisted revision_material stash past the window gets ONE `harness` row from the verdict source (diff ⇒ material true) and is stamped harnessLabelledAt; a later pass never re-labels it', async () => {
    const rev = { ...row({ depth: undefined, check: { state: 'updated', verdict: { material: true, source: 'diff', changed: ['a', 'b'], decisionId: 'rm1', decision: { id: 'rm1', purpose: 'revision_material', mode: 'shadow', backend: 'TypeSafe Jev', answers: { material: { type: 'noul', noul: 0.3 } }, decidedAt: 'now' } } } }) };
    delete (rev.metadata as any).depth;
    mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([rev]);
    const summary = await runComputePolicyWindowCloserOnce({ now: NOW });
    expect(summary).toMatch(/revision_material harness-labelled 1, skipped 0, failed 0 of 1/);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'rm1' });
    expect(purpose).toBe('revision_material');
    expect(outcome).toMatchObject({ question: 'material', actual: true, acted: false, label: 'harness', sessionId: 'c1', extra: { source: 'window_close', harness: true, diffSource: 'diff', changed: 2 } });
    expect(outcome.excludeFromFit).toBeUndefined();
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.metadata.check.verdict.harnessLabelledAt).toBe(NOW.toISOString());
    expect(upd.data.metadata.check.verdict.source).toBe('diff'); // the verdict itself is not rewritten
    // The revision query is bounded like the closer's and keyed on the verdict decision + the stamp.
    const [strings] = mockPrisma.$queryRaw.mock.calls[1];
    const sql = String(strings.join('?'));
    expect(sql).toContain(`'check' -> 'verdict' -> 'decision' IS NOT NULL`);
    expect(sql).toContain(`'harnessLabelledAt' IS NULL`);
  });
  it('E10: a gate-decided (acted) verdict is recorded acted:true + excludeFromFit; a fallback verdict ⇒ material false; a row without a revision stash is left unstamped', async () => {
    const mk = (source: string) => ({ ...row({ check: { state: source === 'gate' ? 'checked' : 'updated', verdict: { material: source !== 'gate', source, decision: { id: `rm-${source}`, purpose: 'revision_material', mode: source === 'gate' ? 'act' : 'shadow', backend: 'jev', answers: { material: { type: 'noul', noul: 0.1 } }, decidedAt: 'now' } } } }) });
    mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([mk('gate'), mk('fallback'), row()]);
    expect(await runComputePolicyWindowCloserOnce({ now: NOW })).toMatch(/harness-labelled 2, skipped 1, failed 0 of 3/);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: false, acted: true, label: 'harness', excludeFromFit: true });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ actual: false, acted: false, label: 'harness' });
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(2); // the stash-less row is never stamped
  });
  it('the candidate query bounds: older than the 30-min window, younger than 3 days, unclosed decision rows only', async () => {
    await runComputePolicyWindowCloserOnce({ now: NOW, batch: 50 });
    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0];
    const sql = String(strings.join('?'));
    expect(sql).toContain(`"metadata" -> 'depth' -> 'decision' IS NOT NULL`);
    expect(sql).toContain(`'windowClosedAt' IS NULL`);
    expect(values[0]).toEqual(new Date(NOW.getTime() - 30 * 60_000));
    expect(values[1]).toEqual(new Date(NOW.getTime() - 3 * 24 * 60 * 60_000));
    expect(values[2]).toBe(50);
  });
  it('the job id', () => {
    expect(WINDOW_CLOSER_JOB_ID).toBe('compute-policy-window-closer');
  });
  it('a failing query never throws — the pass is skipped with a summary', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('db down'));
    expect(await runComputePolicyWindowCloserOnce({ now: NOW })).toMatch(/query failed: db down/);
  });
});

describe('turn_plan window-close pass (dynamic roster 2026-10-03)', () => {
  const tpRow = (over: Record<string, any> = {}) => ({
    id: 'm1', chatId: 'c1', createdAt: new Date('2026-09-26T20:00:00Z'),
    metadata: { depth: { turnPlan: { lane: 'quick', act: true, stash: { id: 'tp1', purpose: 'turn_plan', mode: 'act', backend: 'TypeSafe Jev', answers: { lane: { type: 'choice', choice: 'quick', confidence: 0.8, probabilities: { quick: 0.8, standard: 0.1, checked: 0.05, research: 0.05 } } }, decidedAt: '2026-09-26T20:00:00.000Z' }, roster: { lead: 'cql:q' } }, ...over } },
  });
  beforeEach(() => { delete process.env.TURN_PLAN_LABELS_DISABLED; });
  it('an untapped answer past the window: ONE primary row (the lane held), stamped windowClosedAt', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([tpRow()]);
    expect(await runTurnPlanWindowCloserOnce({ now: NOW })).toBe('turn_plan closed 1, tapped 0, failed 0 of 1');
    const turnPlanCall = mockRecord.mock.calls.find(c => c[1] === 'turn_plan')!;
    expect(turnPlanCall[2]).toMatchObject({ question: 'lane', actual: 'quick', acted: true, label: 'escalated', sessionId: 'c1' });
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.data.metadata.depth.turnPlan).toMatchObject({ lane: 'quick', windowClosedAt: NOW.toISOString(), windowClosedReason: 'labelled' });
  });
  it('a tapped answer was labelled at the tap: stamped only', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([tpRow({ escalations: [{ rung: 'verify', at: 't' }] })]);
    expect(await runTurnPlanWindowCloserOnce({ now: NOW })).toBe('turn_plan closed 0, tapped 1, failed 0 of 1');
    expect(mockRecord.mock.calls.filter(c => c[1] === 'turn_plan')).toHaveLength(0);
    expect(mockPrisma.crossModelMessage.update.mock.calls[0][0].data.metadata.depth.turnPlan.windowClosedReason).toBe('tapped');
  });
  it('rides the compute_policy pass AFTER it; TURN_PLAN_LABELS_DISABLED=1 skips it; a query failure is silent', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([tpRow()]); // compute pass, revision pass, then turn_plan
    expect(await runComputePolicyWindowCloserOnce({ now: NOW })).toMatch(/turn_plan closed 1/);
    process.env.TURN_PLAN_LABELS_DISABLED = '1';
    expect(await runTurnPlanWindowCloserOnce({ now: NOW })).toBe('');
    delete process.env.TURN_PLAN_LABELS_DISABLED;
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    expect(await runTurnPlanWindowCloserOnce({ now: NOW })).toBe('');
  });
});
