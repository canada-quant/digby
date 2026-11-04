/**
 * strike-adjudication × decision gate (N1, 2026-09-25, purpose 'guard_strike').
 *
 * The gate runs as PASS 3 of the nightly adjudicator, AFTER the deterministic
 * pass and the ONE bounded utilityChat batch have produced their verdicts:
 *  - off / kill switch → the seat is never consulted; the pass is byte-identical.
 *  - shadow → every strike adjudicated tonight is put to the gate; the pass's
 *             verdict is the outcome label (acted:false); nothing is written
 *             by the gate; the over-cap remainder is NOT asked (no label).
 *  - act    → the over-cap ambiguous remainder is ALSO asked, and a confident
 *             non-unclear answer is written through adjudicateStrike
 *             (acted:true); labelled rows are still never re-written.
 *  - fail-open: a null / throwing gate leaves adjudication and the summary's
 *             numbers exactly as they were.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAdjudicateStrike: jest.Mock = jest.fn(async () => true);
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  adjudicateStrike: (...a: any[]) => mockAdjudicateStrike(...a),
}));

const mockUtilityChat: jest.Mock = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []) },
  runJournalEntry: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  confidenceOf: (a: any) => (a?.type === 'noul' ? Math.max(a.noul, 1 - a.noul) : typeof a?.confidence === 'number' ? a.confidence : 0),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  buildStrikeGateState,
  gateStrikes,
  guardStrikeGateCap,
  runStrikeAdjudicationOnce,
  ADJUDICATION_LLM_CAP,
  GUARD_STRIKE_GATE_DEFAULT_CAP,
  GUARD_STRIKE_GATE_QUESTION,
  GUARD_STRIKE_GATE_QUESTIONS,
  type StrikeGateItem,
} from './strike-adjudication.service';

const NOW = new Date('2026-09-25T02:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);

let seq = 0;
const strikeRow = (meta: any, o?: { runId?: string | null; minAgo?: number }) => ({
  id: `strike-${++seq}`,
  runId: o?.runId === undefined ? `run-${seq}` : o.runId,
  sessionId: 'sess-1',
  createdAt: at(o?.minAgo ?? 60),
  meta,
});

const choice = (c: string, confidence = 0.95, mode: 'shadow' | 'act' = 'shadow') => ({
  id: `d-${c}-${confidence}`, mode, backend: 'TypeSafe Jev', ms: 5,
  answers: { [GUARD_STRIKE_GATE_QUESTION]: { type: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});

const ENV = ['DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP', 'STRIKE_ADJUDICATION_DISABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockAdjudicateStrike.mockResolvedValue(true);
  mockUtilityChat.mockResolvedValue('');
  mockDecide.mockResolvedValue(null);
  mockMode.mockReturnValue('off');
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockPrisma.runJournalEntry.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('pure pieces', () => {
  it('the question is a three-way Choice in the adjudicator vocabulary with criteria per option', () => {
    const q = GUARD_STRIKE_GATE_QUESTIONS[GUARD_STRIKE_GATE_QUESTION];
    expect(q.type).toBe('choice');
    expect(Object.keys((q as any).criteria).sort()).toEqual(['false_positive', 'true_positive', 'unclear']);
  });

  it('buildStrikeGateState pre-computes counts, carries run context, and NEVER carries the adjudication or the vendor', () => {
    const state = buildStrikeGateState(
      {
        seam: 'machine_wake_reject_back', guard: 'action-verifier', model: 'glm-5.3', provider: 'zai', profile: 'chat',
        phantoms: ['a', 'b'], ids: ['x'], clockHits: [{ line: 'l1 '.repeat(200), token: '22:10Z', minutesAhead: 83 }, { line: 'l2' }],
        kinds: ['future_dated', 'phantom_id', 'k3', 'k4', 'k5', 'k6', 'k7'], tokens: ['G_SHA16_s3/s5'], markedLines: 0, observedLines: 1,
        citationRetry: 'still_dirty', supervisorScope: 'project', triggerKind: 'hook',
        adjudication: 'true_positive', adjudicatedAt: '2026-09-25T01:00:00Z',
      },
      { runStatus: 'completed', journal: { goal: 'g', outcome: 'o', failures: ['f1', 'f2', 'f3'] }, laterCleanFinalize: true },
    );
    expect(state).toMatchObject({
      seam: 'machine_wake_reject_back', guard: 'action-verifier', phantom_ids: 2, cited_ids: 1, clock_hits: 2,
      marked_lines: 0, observed_lines: 1, citation_retry: 'still_dirty', run_status: 'completed', later_clean_finalize: true,
      journal_goal: 'g', journal_outcome: 'o', journal_failures: 'f1; f2', numeric_tokens: ['G_SHA16_s3/s5'],
    });
    expect((state.findings as string[]).length).toBe(6);
    expect(String((state.first_clock_hit as any).line).length).toBeLessThanOrEqual(300);
    expect(state).not.toHaveProperty('adjudication');
    expect(state).not.toHaveProperty('adjudicatedAt');
    expect(state).not.toHaveProperty('model');
    expect(state).not.toHaveProperty('provider');
    expect(JSON.stringify(state).length).toBeLessThan(2600);
  });

  it('a seam-less finalize strike reads seam "finalize"; garbage meta and no facts still build', () => {
    expect(buildStrikeGateState({ kinds: ['future_dated'] }, { laterCleanFinalize: false })).toMatchObject({ seam: 'finalize', findings: ['future_dated'], later_clean_finalize: false });
    expect(buildStrikeGateState(null, { laterCleanFinalize: false })).toEqual({ seam: 'finalize', later_clean_finalize: false });
  });

  it('cap env parsing', () => {
    expect(guardStrikeGateCap()).toBe(GUARD_STRIKE_GATE_DEFAULT_CAP);
    process.env.DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP = '5000';
    expect(guardStrikeGateCap()).toBe(2000);
    process.env.DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP = '-3';
    expect(guardStrikeGateCap()).toBe(0);
    process.env.DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP = 'abc';
    expect(guardStrikeGateCap()).toBe(GUARD_STRIKE_GATE_DEFAULT_CAP);
  });
});

describe('gateStrikes', () => {
  const item = (verdict: 'true_positive' | 'false_positive' | 'unclear' | null, minAgo = 60): StrikeGateItem => ({
    row: strikeRow({ seam: 'reject_back' }, { minAgo }), verdict, source: verdict ? 'llm' : 'none', facts: { laterCleanFinalize: false },
  });

  it('mode off → no decide call, empty summary', async () => {
    expect(await gateStrikes([item('true_positive')], { mode: 'off' })).toMatchObject({ mode: 'off', asked: 0 });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('shadow: every LABELLED item is asked (over-cap items are not), the verdict is the outcome, agreement counted, nothing written', async () => {
    mockDecide.mockImplementation(async (state: any) => choice(state.later_clean_finalize ? 'true_positive' : 'false_positive'));
    const a = item('true_positive'); a.facts.laterCleanFinalize = true;   // gate says true_positive → agrees
    const b = item('true_positive');                                     // gate says false_positive → disagrees
    const overCap = item(null);
    const out = await gateStrikes([a, b, overCap], { mode: 'shadow' });
    expect(out).toMatchObject({ mode: 'shadow', asked: 2, labelled: 2, agreed: 1, wrote: 0, errors: 0 });
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'guard_strike', sessionId: 'sess-1' });
    expect(mockDecide.mock.calls[0][1]).toBe(GUARD_STRIKE_GATE_QUESTIONS);
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    for (const [, purpose, outcome] of mockRecord.mock.calls) {
      expect(purpose).toBe('guard_strike');
      expect(outcome).toMatchObject({ question: GUARD_STRIKE_GATE_QUESTION, actual: 'true_positive', acted: false, sessionId: 'sess-1' });
      expect(String(outcome.note)).toContain('label:llm seam=reject_back');
    }
  });

  it('the nightly cap bounds the calls, labelled items first, newest first', async () => {
    mockDecide.mockResolvedValue(choice('unclear', 0.5));
    const old = item('true_positive', 600);
    const fresh = item('false_positive', 5);
    const overCap = item(null, 1);
    const out = await gateStrikes([old, overCap, fresh], { mode: 'act', cap: 2 });
    expect(out.asked).toBe(2);
    const askedStates = mockDecide.mock.calls.map((c) => c[0]);
    expect(askedStates).toHaveLength(2);
    // Both labelled rows were asked (the over-cap row lost to the cap); the fresh one first.
    const outcomes = mockRecord.mock.calls.map((c) => c[2].actual);
    expect(outcomes).toEqual(['false_positive', 'true_positive']);
  });

  it('act: an over-cap item with a CONFIDENT non-unclear answer is written through adjudicateStrike (acted:true); unclear / below threshold are not', async () => {
    mockDecide
      .mockResolvedValueOnce(choice('false_positive', 0.96, 'act'))
      .mockResolvedValueOnce(choice('unclear', 0.99, 'act'))
      .mockResolvedValueOnce(choice('true_positive', 0.6, 'act'));
    const items = [item(null), item(null), item(null)];
    const out = await gateStrikes(items, { mode: 'act', concurrency: 1 });
    expect(out).toMatchObject({ mode: 'act', asked: 3, labelled: 0, wrote: 1, errors: 0 });
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(1);
    expect(mockAdjudicateStrike).toHaveBeenCalledWith(items[0].row.id, 'false_positive');
    const acted = mockRecord.mock.calls.map((c) => c[2]);
    expect(acted[0]).toMatchObject({ actual: null, acted: true });
    expect(String(acted[0].note)).toContain('adjudicated by gate');
    expect(acted[1]).toMatchObject({ actual: null, acted: false });
    expect(acted[2]).toMatchObject({ actual: null, acted: false });
  });

  it('act never re-writes a LABELLED row, even on a confident disagreeing answer', async () => {
    mockDecide.mockResolvedValue(choice('false_positive', 0.99, 'act'));
    const out = await gateStrikes([item('true_positive')], { mode: 'act' });
    expect(out).toMatchObject({ asked: 1, labelled: 1, agreed: 0, wrote: 0 });
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'true_positive', acted: false });
  });

  it('a null or throwing gate counts as an error and records nothing; a failing over-cap write is an error too', async () => {
    mockDecide.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(choice('true_positive', 0.99, 'act'));
    mockAdjudicateStrike.mockRejectedValueOnce(new Error('db down'));
    const out = await gateStrikes([item('true_positive'), item('false_positive'), item(null)], { mode: 'act', concurrency: 1 });
    expect(out).toMatchObject({ asked: 1, labelled: 0, wrote: 0, errors: 3 });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('runStrikeAdjudicationOnce × gate (pass 3)', () => {
  const rows = () => [
    strikeRow({ seam: 'tool_preflight' }, { minAgo: 10 }),                                  // deterministic true_positive
    strikeRow({ seam: 'reject_back' }, { minAgo: 20 }),                                     // ambiguous → LLM batch
    strikeRow({ seam: 'numeric_provenance', tokens: ['G_SHA16'] }, { minAgo: 30 }),         // ambiguous → LLM batch
  ];

  it('off (the hermetic default): adjudication and the summary are unchanged and the seat is never consulted', async () => {
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => (where?.kind === 'guard_strike' ? rows() : []));
    mockUtilityChat.mockResolvedValue('[{"i":1,"v":"true_positive"},{"i":2,"v":"false_positive"}]');
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('adjudicated 3/3 strikes (deterministic 1: tp 1, fp 0; llm 2/2: tp 1, fp 1, unclear 0)');
    expect(summary).not.toContain('decision gate');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("shadow: tonight's deterministic + LLM verdicts are the labels; the LLM rows carry run status + journal in their state; the summary reports agreement", async () => {
    mockMode.mockReturnValue('shadow');
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => (where?.kind === 'guard_strike' ? rows() : []));
    mockPrisma.runJournalEntry.findMany.mockResolvedValue([{ runId: 'run-2', goal: 'ship it', outcome: 'claimed merged', failures: [] }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-2', status: 'completed' }, { id: 'run-3', status: 'failed' }]);
    mockUtilityChat.mockResolvedValue('[{"i":1,"v":"true_positive"},{"i":2,"v":"false_positive"}]');
    mockDecide.mockImplementation(async (state: any) => choice(state.seam === 'numeric_provenance' ? 'unclear' : 'true_positive'));

    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('adjudicated 3/3 strikes');
    expect(summary).toContain('decision gate (shadow): asked 3, agreed 2/3 labelled');
    // The pass's writes are exactly the pre-gate ones: 3 verdicts, none by the gate.
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(3);
    expect(mockDecide).toHaveBeenCalledTimes(3);
    const states = mockDecide.mock.calls.map((c) => c[0]);
    const llmReject = states.find((s) => s.seam === 'reject_back');
    expect(llmReject).toMatchObject({ run_status: 'completed', journal_goal: 'ship it', journal_outcome: 'claimed merged' });
    expect(states.find((s) => s.seam === 'numeric_provenance')).toMatchObject({ run_status: 'failed', numeric_tokens: ['G_SHA16'] });
    const labels = mockRecord.mock.calls.map((c) => c[2]);
    expect(labels.map((l) => l.actual).sort()).toEqual(['false_positive', 'true_positive', 'true_positive']);
    expect(labels.every((l) => l.acted === false)).toBe(true);
    expect(labels.some((l) => String(l.note).startsWith('label:deterministic'))).toBe(true);
    expect(labels.some((l) => String(l.note).startsWith('label:llm'))).toBe(true);
  });

  it('shadow: the over-cap ambiguous remainder is NOT asked (no label tonight); act asks it and writes confident verdicts', async () => {
    const many = Array.from({ length: ADJUDICATION_LLM_CAP + 2 }, (_, i) => strikeRow({ seam: 'reject_back' }, { minAgo: i + 1 }));
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => (where?.kind === 'guard_strike' ? many : []));
    mockUtilityChat.mockResolvedValue('[]'); // the batch answered nothing usable — no LLM labels tonight
    mockDecide.mockResolvedValue(choice('false_positive', 0.97, 'act'));

    mockMode.mockReturnValue('shadow');
    let summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain(`2 ambiguous over the ${ADJUDICATION_LLM_CAP}/night cap`);
    expect(summary).toContain('decision gate (shadow): asked 0, agreed 0/0 labelled');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => (where?.kind === 'guard_strike' ? many : []));
    mockUtilityChat.mockResolvedValue('[]');
    mockDecide.mockResolvedValue(choice('false_positive', 0.97, 'act'));
    mockAdjudicateStrike.mockResolvedValue(true);
    mockMode.mockReturnValue('act');
    summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('decision gate (act): asked 2, agreed 0/0 labelled, wrote 2 over-cap');
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(2);
    // The two over-cap rows are the OLDEST two (the batch took the newest 30).
    const written = mockAdjudicateStrike.mock.calls.map((c) => c[0]).sort();
    expect(written).toEqual([many[ADJUDICATION_LLM_CAP].id, many[ADJUDICATION_LLM_CAP + 1].id].sort());
    expect(mockAdjudicateStrike.mock.calls.every((c) => c[1] === 'false_positive')).toBe(true);
  });

  it('a throwing gate fails open: the adjudication numbers are unchanged and the summary names the error count', async () => {
    mockMode.mockReturnValue('shadow');
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => (where?.kind === 'guard_strike' ? rows() : []));
    mockUtilityChat.mockResolvedValue('[{"i":1,"v":"true_positive"},{"i":2,"v":"unclear"}]');
    mockDecide.mockRejectedValue(new Error('seat down'));
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('adjudicated 3/3 strikes (deterministic 1: tp 1, fp 0; llm 2/2: tp 1, fp 0, unclear 1)');
    expect(summary).toContain('decision gate (shadow): asked 0, agreed 0/0 labelled, 3 error(s)');
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(3);
  });
});
