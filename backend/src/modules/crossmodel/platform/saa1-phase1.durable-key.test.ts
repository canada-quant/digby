/**
 * SAA-1.1 PHASE 1a — DURABLE HOOK-BATCH CORRELATION (todo 03bcf00f).
 *
 * The observe row names its batch (`hookId` + `ids`), but the LABEL side did
 * not: a `decision_gate` outcome row carries `stateHash`, never a hookId, and
 * `wake_delivered` carries `hookId` with no ids and no runId. So a batch could
 * only be tied to the run that finalised it TEMPORALLY, and the 2026-11-03
 * replay resolved 4 of 1,909 would-suppress batches (0.21% coverage) — the
 * join, not the traffic, was the binding constraint.
 *
 * These tests pin the fix: ONE string, stamped unchanged on the delivery side
 * and on the label side, so a join needs no time window.
 */
import { hookBatchKey } from './hook-source-policy';
import type { SuppressionLaterLabel } from './hook-source-policy';
import { stashDecision, stashExtra } from './decision-gate';
import { WAKE_TRIAGE_CONTROL_EXTRA } from './wake-triage-request';
import {
  batchKeyOf,
  buildDurableLabelIndex,
  gradeSuppressionByKey,
  observeRowsFromMetrics,
} from './hook-source-policy-grader';

// decision-gate pulls config/env (which hard-exits on a missing secret) and
// loop-metrics.service's prisma graph. The emit-side assertions here are about
// STASH PLUMBING ONLY, so the same two mocks the sibling label tests use are
// enough — and they keep this suite a pure unit test.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', HOOK_SOURCE_POLICY_OBSERVE: 'hook_source_policy_observe' },
  recordLoopMetric: jest.fn(),
}));

const HOOK = '3290bc52-e16d-479e-adbf-7fbc7aad536f';

function observeRow(ids: string[], decision: 'respond' | 'ignore', ms: number, hookId = HOOK) {
  return {
    createdAt: new Date(1_700_000_000_000 + ms).toISOString(),
    sessionId: 'chat-1',
    meta: { hookId, decision, reason: decision === 'ignore' ? 'routine_completion' : 'failure_or_block', rows: ids.length, sources: 1, ids },
  };
}

describe('hookBatchKey — the durable correlation key', () => {
  it('is a single stable string naming hook and batch', () => {
    expect(hookBatchKey(HOOK, ['aaaaaaaa', 'bbbbbbbb'])).toBe(`${HOOK}|aaaaaaaa,bbbbbbbb`);
  });

  it('returns null when it cannot identify a batch (never a partial key)', () => {
    expect(hookBatchKey('', ['aaaaaaaa'])).toBeNull();
    expect(hookBatchKey(HOOK, [])).toBeNull();
    expect(hookBatchKey(null, ['a'])).toBeNull();
    expect(hookBatchKey(HOOK, ['  '])).toBeNull();
  });

  it('stays within the 80-char compactExtra budget, so the two sides can never diverge', () => {
    // A 36-char uuid + three 8-char ids is 63 chars — the real shape.
    const real = hookBatchKey(HOOK, ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(real!.length).toBeLessThanOrEqual(80);
    expect(real!.length).toBe(36 + 1 + 8 * 3 + 2);
    // An over-long input is canonicalised ONCE, identically on both sides.
    const long = hookBatchKey('h'.repeat(90), ['a']);
    expect(long!.length).toBe(80);
  });

  // ── THE TRUNCATION ASYMMETRY (review defect C) ──────────────────────────
  // 3844f715 fixed the ORDER disagreement but left a second one: hookBatchKey
  // sliced to 80 while batchKeyOf did not, so a batch whose id list pushed the
  // raw key past 80 (36-char uuid + FIVE 8-char ids = 86) was stamped truncated
  // and deduped untruncated — a silent 0% join for exactly those batches. Live
  // keys maxed at 54 chars on 2026-11-03, so it was latent, not active.
  it('agrees with batchKeyOf for a batch large enough to exceed the 80-char budget', () => {
    const fiveIds = ['11111111', '22222222', '33333333', '44444444', '55555555'];
    // the shape that actually breaks: real 36-char hook uuid + five ids = 81 raw
    expect(`${HOOK}|${fiveIds.join(',')}`.length).toBeGreaterThan(80);
    const stamped = hookBatchKey(HOOK, fiveIds)!;
    expect(stamped.length).toBeLessThanOrEqual(80);
    // THE CONTRACT: the stamp side and the dedupe side are the same string.
    expect(stamped).toBe(batchKeyOf(HOOK, fiveIds));
    // …and reversing the ids still agrees, on both sides.
    expect(hookBatchKey(HOOK, [...fiveIds].reverse())).toBe(stamped);
    expect(batchKeyOf(HOOK, [...fiveIds].reverse())).toBe(stamped);
  });

  it('never collapses two DISTINCT large batches onto one key (no collision by truncation)', () => {
    // Plain truncation on the dedupe side would be worse than the original bug:
    // two distinct large batches sharing an 80-char prefix would merge into ONE
    // batch, inflating its admissions and mis-attributing a label to it. The
    // digest suffix is what makes that impossible.
    const base = ['11111111', '22222222', '33333333', '44444444'];
    const a = hookBatchKey(HOOK, [...base, 'aaaaaaaa'])!;
    const b = hookBatchKey(HOOK, [...base, 'bbbbbbbb'])!;
    expect(a).not.toBe(b);
    expect(batchKeyOf(HOOK, [...base, 'aaaaaaaa'])).not.toBe(batchKeyOf(HOOK, [...base, 'bbbbbbbb']));
    // both still inside the budget the outcome row's compactExtra enforces
    expect(a.length).toBeLessThanOrEqual(80);
    expect(b.length).toBeLessThanOrEqual(80);
  });

  it('a large batch still JOINS end-to-end through the grader', () => {
    // The point of the key: a >80-char batch must resolve, not sit unresolved.
    const fiveIds = ['11111111', '22222222', '33333333', '44444444', '55555555'];
    const stamped = hookBatchKey(HOOK, fiveIds)!;
    const observe = {
      createdAt: new Date(1_700_000_000_000).toISOString(),
      sessionId: 'chat-1',
      meta: { hookId: HOOK, decision: 'ignore', reason: 'routine_completion', rows: 5, sources: 1, ids: fiveIds },
    };
    const index = buildDurableLabelIndex([{ createdAt: new Date(2), meta: { hookBatch: stamped, actual: false } }]);
    const g = gradeSuppressionByKey(observeRowsFromMetrics([observe]), index);
    expect(g.wouldSuppress).toBe(1);
    expect(g.wouldHold).toBe(1);
    expect(g.unresolved).toBe(0);
    expect(g.precision).toBe(1);
  });

  it('is deterministic — the same batch always yields the same key', () => {
    expect(hookBatchKey(HOOK, ['aa', 'bb'])).toBe(hookBatchKey(HOOK, ['aa', 'bb']));
  });

  // ── THE CROSS-SIDE CONTRACT (review defect A) ────────────────────────────
  // The stamp side and the dedupe side are DIFFERENT functions in different
  // modules. They shipped disagreeing: hookBatchKey joined arrival order while
  // batchKeyOf sorted, so a 3-id batch produced "…|9f2a1b7c,3d8e0a11,77ab00cd"
  // on one side and "…|3d8e0a11,77ab00cd,9f2a1b7c" on the other. The join was
  // therefore 0% for every batch of 2+ ids — invisible to fixtures whose ids
  // happened to be pre-sorted. This asserts the two agree on UNSORTED input.
  it('produces the SAME string as the grader’s batchKeyOf for unsorted ids', () => {
    const unsorted = ['9f2a1b7c', '3d8e0a11', '77ab00cd'];
    expect(hookBatchKey(HOOK, unsorted)).toBe(batchKeyOf(HOOK, unsorted));
    expect(hookBatchKey(HOOK, ['zz11', 'aa22'])).toBe(batchKeyOf(HOOK, ['zz11', 'aa22']));
    // and reversing the order must not change either side
    expect(hookBatchKey(HOOK, [...unsorted].reverse())).toBe(hookBatchKey(HOOK, unsorted));
  });

  it('so a label stamped at emission JOINS the batch the grader deduped', () => {
    // End-to-end over the exact real-world shape: the policy emits ids in
    // arrival order; the label side stamps hookBatchKey; the grader dedupes with
    // batchKeyOf. The grade must resolve, not sit at 0% coverage.
    const arrivalOrder = ['9f2a1b7c', '77ab00cd', '3d8e0a11'];
    const stamped = hookBatchKey(HOOK, arrivalOrder)!;
    const observe = {
      createdAt: new Date(1_700_000_000_000).toISOString(),
      sessionId: 'chat-1',
      meta: { hookId: HOOK, decision: 'ignore', reason: 'routine_completion', rows: 3, sources: 1, ids: arrivalOrder },
    };
    const index = buildDurableLabelIndex([{ createdAt: new Date(2), meta: { hookBatch: stamped, actual: false } }]);
    const g = gradeSuppressionByKey(observeRowsFromMetrics([observe]), index);
    expect(g.wouldSuppress).toBe(1);
    expect(g.wouldHold).toBe(1);
    expect(g.unresolved).toBe(0);
    expect(g.precision).toBe(1);
  });
});

describe('gradeSuppressionByKey — exact join, no time window', () => {
  it('resolves a batch whose label key matches, EXACTLY', () => {
    const rows = [observeRow(['aaaaaaaa'], 'ignore', 0)];
    const key = hookBatchKey(HOOK, ['aaaaaaaa'])!;
    const index = new Map<string, SuppressionLaterLabel>([[key, { delivered: true, acted: false }]]);
    const g = gradeSuppressionByKey(observeRowsFromMetrics(rows), index);
    expect(g.wouldSuppress).toBe(1);
    expect(g.wouldHold).toBe(1);
    expect(g.wouldLose).toBe(0);
    expect(g.unresolved).toBe(0);
    expect(g.precision).toBe(1);
  });

  it('does NOT resolve a batch whose key differs, even in the same chat and second', () => {
    // The whole point: proximity is not identity. A different batch's label in
    // the same window must not be borrowed.
    const rows = [observeRow(['aaaaaaaa'], 'ignore', 0), observeRow(['bbbbbbbb'], 'ignore', 5)];
    const otherKey = hookBatchKey(HOOK, ['bbbbbbbb'])!;
    const index = new Map<string, SuppressionLaterLabel>([[otherKey, { delivered: true, acted: true }]]);
    const g = gradeSuppressionByKey(observeRowsFromMetrics(rows), index);
    expect(g.wouldSuppress).toBe(2);
    expect(g.wouldLose).toBe(1);   // the one whose key matched
    expect(g.unresolved).toBe(1);  // the one whose key did not — NOT guessed
    expect(g.precision).toBe(0);
  });

  it('returns NULL precision when no key matches — never 1.0', () => {
    const rows = [observeRow(['aaaaaaaa'], 'ignore', 0)];
    const g = gradeSuppressionByKey(observeRowsFromMetrics(rows), new Map());
    expect(g.unresolved).toBe(1);
    expect(g.precision).toBeNull();
  });

  it('grades each batch once however many times it was re-admitted', () => {
    // The re-admission loop: one batch, many observe rows, ONE key.
    const rows = Array.from({ length: 33 }, (_, i) => observeRow(['same'], 'ignore', i * 10_000));
    const key = hookBatchKey(HOOK, ['same'])!;
    const index = new Map<string, SuppressionLaterLabel>([[key, { delivered: true, acted: false }]]);
    const g = gradeSuppressionByKey(observeRowsFromMetrics(rows), index);
    expect(g.rows).toBe(33);
    expect(g.batches).toBe(1);
    expect(g.wouldHold).toBe(1);
    expect(g.precision).toBe(1);
  });
});

describe('buildDurableLabelIndex', () => {
  it('indexes label rows by their stamped hookBatch key', () => {
    const idx = buildDurableLabelIndex([
      { createdAt: new Date(1000), meta: { hookBatch: 'h1|a,b', actual: true } },
      { createdAt: new Date(2000), meta: { hookBatch: 'h2|c', actual: false } },
    ]);
    expect(idx.get('h1|a,b')).toEqual({ delivered: true, acted: true });
    expect(idx.get('h2|c')).toEqual({ delivered: true, acted: false });
  });

  // ── THE PARK PATH (review defect B) ──────────────────────────────────────
  // A parked batch writes { actual: null, acted: true }. `acted` there is
  // `run.acted`, NOT the harness verdict; `actual` is the verdict field and it
  // is null because no run finalised yet. Reading `acted` first scored every
  // park as would_lose — inflating the policy's failure rate in exactly the
  // direction that looks like the policy disagrees with itself.
  it('does NOT read a PARK row (actual:null, acted:true) as would_lose', () => {
    const idx = buildDurableLabelIndex([
      { createdAt: new Date(1000), meta: { hookBatch: 'h|parked', actual: null, acted: true } },
    ]);
    expect(idx.has('h|parked')).toBe(false);
  });

  it('lets the LATER real outcome row supply the verdict the park row could not', () => {
    const idx = buildDurableLabelIndex([
      { createdAt: new Date(1000), meta: { hookBatch: 'h|b', actual: null, acted: true } },  // park
      { createdAt: new Date(2000), meta: { hookBatch: 'h|b', actual: false, acted: true } }, // real label
    ]);
    expect(idx.get('h|b')).toEqual({ delivered: true, acted: false });
  });

  it('accepts the harness boolean and the string vocabulary on `actual`', () => {
    const idx = buildDurableLabelIndex([
      { createdAt: new Date(1), meta: { hookBatch: 'h|bool', actual: true } },
      { createdAt: new Date(2), meta: { hookBatch: 'h|str', actual: 'false' } },
      { createdAt: new Date(3), meta: { hookBatch: 'h|choice', actual: 'act_now' } },
    ]);
    expect(idx.get('h|bool')).toEqual({ delivered: true, acted: true });
    expect(idx.get('h|str')).toEqual({ delivered: true, acted: false });
    // a foreign vocabulary is NOT a needs-turn-now boolean — never coerced
    expect(idx.has('h|choice')).toBe(false);
  });

  it('ignores rows with no key, and never invents a delivered label', () => {
    const idx = buildDurableLabelIndex([
      { createdAt: new Date(1), meta: { acted: true } },
      { createdAt: new Date(2), meta: null },
      { createdAt: new Date(3), meta: { hookBatch: 'h|a', delivered: false, acted: false } },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get('h|a')).toEqual({ delivered: false, acted: false });
  });
});

/**
 * THE EMIT SIDE. The join tests above prove that IF the key is on both sides it
 * joins exactly. These prove the key actually SURVIVES the emit path — it rides
 * `DecisionStash.extra`, which `stashDecision` compacts and `stashExtra` reads
 * back before `labelOneMachineRunOutcome` stamps it onto the outcome row. A key
 * that compaction strips would leave the label side empty and the coverage at
 * zero, silently.
 */
describe('the key survives the emit path (stash -> outcome)', () => {
  const stash = (extra: Record<string, unknown>) =>
    stashDecision(
      {
        id: 'dec-1', purpose: 'wake_triage', mode: 'act', backend: 'test',
        answers: { needs_turn_now: { type: 'noul', noul: 0.9 } }, decidedAt: new Date().toISOString(),
      } as never,
      'wake_triage',
      { extra },
    );

  it('round-trips the batch key through stashDecision -> stashExtra unchanged', () => {
    const key = hookBatchKey(HOOK, ['aaaaaaaa', 'bbbbbbbb'])!;
    const s = stash({ hookBatch: key });
    expect(s).not.toBeNull();
    expect(stashExtra(s)).toMatchObject({ hookBatch: key });
  });

  it('keeps the key when it rides beside the control-sample extra', () => {
    const key = hookBatchKey(HOOK, ['aaaaaaaa'])!;
    const s = stash({ ...WAKE_TRIAGE_CONTROL_EXTRA, hookBatch: key });
    const back = stashExtra(s);
    expect(back.hookBatch).toBe(key);
    // the pre-existing control flag is not displaced by the new key
    for (const k of Object.keys(WAKE_TRIAGE_CONTROL_EXTRA)) expect(back).toHaveProperty(k);
  });

  it('a key is never silently dropped for being too long (the 80-char clamp holds)', () => {
    const key = hookBatchKey(HOOK, ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])!;
    const back = stashExtra(stash({ hookBatch: key }));
    expect(back.hookBatch).toBe(key); // byte-identical both sides
  });
});