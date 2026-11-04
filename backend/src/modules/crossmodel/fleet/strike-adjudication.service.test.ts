/**
 * N6-adjudication — the nightly guard-strike adjudication job (remediation P8,
 * second half of P0's adjudicateStrike): deterministic heuristics first, ONE
 * bounded utilityChat batch for the ambiguous remainder, per-row write
 * isolation, kill-switch. G17 — the fabrication metric substitute (guard_strike
 * rows in fabrication-class shapes; the worker has no repo checkout, so the
 * brief's git-log commit-subject count is impossible on the box).
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

import {
  classifyStrikeDeterministic,
  isFabricationClassStrike,
  parseAdjudicationVerdicts,
  runStrikeAdjudicationOnce,
  ADJUDICATION_LLM_CAP,
  CONSTRUCTION_TRUE_POSITIVE_SEAMS,
  ADJUDICATION_SKIPPED_SEAMS,
} from './strike-adjudication.service';

const NOW = new Date('2026-09-09T02:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);

let seq = 0;
const strikeRow = (meta: any, o?: { runId?: string | null; minAgo?: number }) => ({
  id: `strike-${++seq}`,
  runId: o?.runId === undefined ? `run-${seq}` : o.runId,
  sessionId: 'sess-1',
  createdAt: at(o?.minAgo ?? 60),
  meta,
});

beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
  delete process.env.STRIKE_ADJUDICATION_DISABLED;
  mockAdjudicateStrike.mockResolvedValue(true);
  mockUtilityChat.mockResolvedValue('');
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockPrisma.runJournalEntry.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
});

describe('N6-adjudication classifyStrikeDeterministic (pure)', () => {
  const base = { citationRetry: undefined, hasFindingKinds: false, laterCleanFinalize: false };

  it('construction-class seams are true_positive by construction', () => {
    for (const seam of CONSTRUCTION_TRUE_POSITIVE_SEAMS) {
      expect(classifyStrikeDeterministic({ ...base, seam })).toBe('true_positive');
    }
  });

  it('a reject_back the model then corrected (same-run later guard_miss) is true_positive', () => {
    expect(classifyStrikeDeterministic({ ...base, seam: 'reject_back', laterCleanFinalize: true })).toBe('true_positive');
    // …without the corrected clean finalize it stays ambiguous.
    expect(classifyStrikeDeterministic({ ...base, seam: 'reject_back' })).toBeNull();
  });

  it('a machine_wake_reject_back that self-corrected (citationRetry clean) is true_positive', () => {
    expect(classifyStrikeDeterministic({ ...base, seam: 'machine_wake_reject_back', citationRetry: 'clean' })).toBe('true_positive');
    expect(classifyStrikeDeterministic({ ...base, seam: 'machine_wake_reject_back', citationRetry: 'still_dirty' })).toBeNull();
  });

  it('a FINALIZE strike whose run later re-finalized guard-clean is false_positive', () => {
    expect(classifyStrikeDeterministic({ ...base, seam: '', hasFindingKinds: true, laterCleanFinalize: true })).toBe('false_positive');
    expect(classifyStrikeDeterministic({ ...base, seam: '', hasFindingKinds: true })).toBeNull();
  });

  it('judgment-lane seams stay ambiguous (numeric_provenance, outbound_claim)', () => {
    expect(classifyStrikeDeterministic({ ...base, seam: 'numeric_provenance' })).toBeNull();
    expect(classifyStrikeDeterministic({ ...base, seam: 'outbound_claim' })).toBeNull();
  });

  it('gate flip 2026-09-11: an OBSERVED zero_tool_prefinal row is no longer true_positive by construction', () => {
    expect(classifyStrikeDeterministic({ ...base, seam: 'zero_tool_prefinal' })).toBeNull();
  });

  it('2026-09-27 open_pull_request verify-gate review: the pr_gate_* relief rows (outcome observed) are neither true_positive by construction nor fabrication-class', () => {
    for (const seam of ['pr_gate_docs_only', 'pr_gate_auto_verify']) {
      expect(classifyStrikeDeterministic({ ...base, seam })).toBeNull();
      expect(isFabricationClassStrike({ seam, outcome: 'observed', state: 'observed' })).toBe(false);
    }
  });
});

describe('G17 isFabricationClassStrike (pure — commit-subject substitute)', () => {
  it('fabrication-class seams + seam-less finalize strikes (kinds) count; mechanical breakers do not', () => {
    expect(isFabricationClassStrike({ seam: 'reject_back' })).toBe(true);
    expect(isFabricationClassStrike({ seam: 'machine_wake_reject_back', citationRetry: 'clean' })).toBe(true);
    // Hardening review 2026-09-14: a citation-class machine-wake strike now carries ONLY this seam (no more paired 'observed' row).
    expect(isFabricationClassStrike({ seam: 'machine_wake_citation_enforce', outcome: 'enforced' })).toBe(true);
    // Deterministic existence arithmetic, but NOT true_positive by construction — it still goes to adjudication like the other fabrication seams.
    expect(classifyStrikeDeterministic({ seam: 'machine_wake_citation_enforce', hasFindingKinds: false, laterCleanFinalize: false })).toBeNull();
    // Gate flip 2026-09-11: numeric_provenance is default-off + 23/24 adjudicated FP — no longer fabrication-class.
    expect(isFabricationClassStrike({ seam: 'numeric_provenance', markedLines: 2 })).toBe(false);
    expect(isFabricationClassStrike({ seam: 'outbound_claim', outcome: 'refused' })).toBe(true);
    expect(isFabricationClassStrike({ kinds: ['fabricated_pr'] })).toBe(true); // finalize strike
    expect(isFabricationClassStrike({ seam: 'tool_derail_break' })).toBe(false);
    expect(isFabricationClassStrike({ seam: 'zero_tool_prefinal', outcome: 'nudged' })).toBe(false);
    expect(isFabricationClassStrike({})).toBe(false);
  });
});

describe('N6-adjudication parseAdjudicationVerdicts (pure)', () => {
  it('parses a fenced JSON array, drops out-of-range indexes and unknown verdicts', () => {
    const raw = '```json\n[{"i":1,"v":"true_positive"},{"i":2,"v":"maybe"},{"i":9,"v":"unclear"},{"i":3,"v":"false_positive"}]\n```';
    const map = parseAdjudicationVerdicts(raw, 3);
    expect([...map.entries()]).toEqual([[1, 'true_positive'], [3, 'false_positive']]);
  });

  it('prose around the array is tolerated; garbage yields an empty map', () => {
    expect([...parseAdjudicationVerdicts('Sure! Here: [{"i":1,"v":"unclear"}] hope that helps', 1).entries()])
      .toEqual([[1, 'unclear']]);
    expect(parseAdjudicationVerdicts('no json here', 5).size).toBe(0);
    expect(parseAdjudicationVerdicts('', 5).size).toBe(0);
  });
});

describe('N6-adjudication runStrikeAdjudicationOnce', () => {
  it('kill-switch STRIKE_ADJUDICATION_DISABLED=1 short-circuits before any read', async () => {
    process.env.STRIKE_ADJUDICATION_DISABLED = '1';
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('disabled');
    expect(mockPrisma.loopMetric.findMany).not.toHaveBeenCalled();
  });

  it('deterministic pass writes verdicts via adjudicateStrike and skips already-adjudicated rows', async () => {
    const derail = strikeRow({ seam: 'tool_derail_break', tool: 'x' });
    const rejectCorrected = strikeRow({ seam: 'reject_back', outcome: 'rejected' }, { runId: 'run-clean' });
    const finalizeFp = strikeRow({ kinds: ['zero_evidence_claims'] }, { runId: 'run-clean-2' });
    const already = strikeRow({ seam: 'tool_repeat_break', adjudication: 'true_positive' });
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([derail, rejectCorrected, finalizeFp, already]) // guard_strike read
      .mockResolvedValueOnce([ // guard_miss read: both runs re-finalized clean LATER
        { runId: 'run-clean', createdAt: at(10) },
        { runId: 'run-clean-2', createdAt: at(10) },
      ]);

    const summary = await runStrikeAdjudicationOnce({ now: NOW });

    expect(mockAdjudicateStrike.mock.calls).toEqual(expect.arrayContaining([
      [derail.id, 'true_positive'],
      [rejectCorrected.id, 'true_positive'],
      [finalizeFp.id, 'false_positive'],
    ]));
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(3); // never the already-adjudicated row
    expect(mockUtilityChat).not.toHaveBeenCalled(); // nothing ambiguous
    expect(summary).toContain('deterministic 3: tp 2, fp 1');
  });

  it('REVIEW FIX 2026-09-27: an observe-only telemetry seam (machine_wake_production_state) is SKIPPED — no deterministic write, no LLM batch, no G17 count', async () => {
    expect(ADJUDICATION_SKIPPED_SEAMS.has('machine_wake_production_state')).toBe(true);
    const observed = strikeRow({ seam: 'machine_wake_production_state', outcome: 'observed', strike: 'production_state_unread', hits: 1 }, { runId: 'run-ps' });
    // ONE read only: with nothing pending the guard_miss lookup never runs (a second queued value would leak into the next test).
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([observed]);
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(mockPrisma.loopMetric.findMany).toHaveBeenCalledTimes(1);
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(summary).toContain('adjudicated 0/0 strikes');
    expect(summary).toContain('1 observe-only row(s) skipped');
    expect(summary).toContain('fabrication-class strikes 24h: 0');
  });

  it('a guard_miss EARLIER than the strike is not a correction (order matters)', async () => {
    const reject = strikeRow({ seam: 'reject_back' }, { runId: 'run-x', minAgo: 60 });
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([reject])
      .mockResolvedValueOnce([{ runId: 'run-x', createdAt: at(120) }]); // miss BEFORE the strike
    await runStrikeAdjudicationOnce({ now: NOW });
    // Ambiguous → the LLM batch (which answers '' here) — never a deterministic write.
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('ambiguous remainder goes to ONE utilityChat batch with journal context; verdicts are written', async () => {
    const numeric = strikeRow({ seam: 'numeric_provenance', markedLines: 3 }, { runId: 'run-a' });
    const outbound = strikeRow({ seam: 'outbound_claim', outcome: 'annotated' }, { runId: 'run-b' });
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([numeric, outbound])
      .mockResolvedValueOnce([]); // no guard_miss rows
    mockPrisma.runJournalEntry.findMany.mockResolvedValue([
      { runId: 'run-a', goal: 'watch the queue', outcome: 'reported 3 stale runs', failures: [] },
    ]);
    mockPrisma.agentRun.findMany.mockResolvedValue([
      { id: 'run-a', status: 'completed' }, { id: 'run-b', status: 'completed' },
    ]);
    mockUtilityChat.mockResolvedValue('[{"i":1,"v":"true_positive"},{"i":2,"v":"unclear"}]');

    const summary = await runStrikeAdjudicationOnce({ now: NOW });

    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const prompt = mockUtilityChat.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('seam=numeric_provenance');
    expect(prompt).toContain('seam=outbound_claim');
    expect(prompt).toContain('watch the queue'); // journal context rode along
    expect(prompt).toContain('runStatus=completed');
    expect(mockAdjudicateStrike.mock.calls).toEqual(expect.arrayContaining([
      [numeric.id, 'true_positive'],
      [outbound.id, 'unclear'],
    ]));
    expect(summary).toContain('llm 2/2: tp 1, fp 0, unclear 1');
  });

  it(`the LLM batch is capped at ${ADJUDICATION_LLM_CAP}/night — overflow stays unadjudicated for the next night`, async () => {
    const rows = Array.from({ length: ADJUDICATION_LLM_CAP + 5 }, () =>
      strikeRow({ seam: 'numeric_provenance' }, { runId: null }));
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce(rows);
    mockUtilityChat.mockResolvedValue(
      JSON.stringify(Array.from({ length: ADJUDICATION_LLM_CAP + 5 }, (_, i) => ({ i: i + 1, v: 'unclear' }))));

    const summary = await runStrikeAdjudicationOnce({ now: NOW });

    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    // Out-of-range verdicts (beyond the 30 sent) are dropped by the parser.
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(ADJUDICATION_LLM_CAP);
    expect(summary).toContain(`5 ambiguous over the ${ADJUDICATION_LLM_CAP}/night cap`);
  });

  it('a failed/empty utilityChat leaves the ambiguous rows for the next night (no throw)', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([strikeRow({ seam: 'outbound_claim' }, { runId: null })]);
    mockUtilityChat.mockResolvedValue(''); // the utility-llm total-failure shape
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(mockAdjudicateStrike).not.toHaveBeenCalled();
    expect(summary).toContain('adjudicated 0/1');
  });

  it('one failed adjudicateStrike write never kills the pass (per-row isolation)', async () => {
    const a = strikeRow({ seam: 'tool_derail_break' });
    const b = strikeRow({ seam: 'tool_repeat_break' });
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([a, b]);
    mockAdjudicateStrike.mockRejectedValueOnce(new Error('db hiccup'));
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(mockAdjudicateStrike).toHaveBeenCalledTimes(2);
    expect(summary).toContain('1 write failure(s)');
  });

  it('G17 substitute: the summary reports fabrication-class strikes over ALL last-24h rows, adjudicated or not', async () => {
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([
        strikeRow({ seam: 'reject_back', adjudication: 'true_positive' }), // already adjudicated — still counted
        strikeRow({ seam: 'numeric_provenance' }, { runId: null }), // gate flip 2026-09-11: no longer fabrication-class
        strikeRow({ kinds: ['fabricated_sha'] }, { runId: null }),
        strikeRow({ seam: 'tool_derail_break' }), // mechanical — not fabrication-class
      ]);
    const summary = await runStrikeAdjudicationOnce({ now: NOW });
    expect(summary).toContain('fabrication-class strikes 24h: 2 (G17 commit-subject substitute)');
  });

  it('never throws — a DB failure returns a non-fatal summary', async () => {
    mockPrisma.loopMetric.findMany.mockRejectedValue(new Error('db down'));
    await expect(runStrikeAdjudicationOnce({ now: NOW })).resolves.toContain('non-fatal');
  });
});
