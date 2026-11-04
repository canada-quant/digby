const mockStoreGet = jest.fn(async (..._a: any[]): Promise<unknown> => null);
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: (...a: any[]) => mockStoreGet(...a) }));

import {
  MODEL_BENCH_STORE_KEY, MODEL_BENCH_STORE_NS, MODEL_BENCH_MAX_RUNS, ModelBenchRow, ModelBenchScorecard,
  aggregateBenchRows, attributeBenchRow, benchPercentile, benchRowFromTurn, benchTitle, clearModelBenchScorecardCache,
  isBenchSideRow, mergeScorecards, normalizeScorecard, parseBenchTitle, pickBenchTurn, readModelBenchScorecard,
  BENCH_WEB_TOOL_NAMES, countBenchWebToolCalls, benchRowKind, KIND_BUCKET_KEEP_MIN_N,
} from './model-bench-scorecard';
import { BENCH_KIND_MIN_N } from './model-evidence';

const row = (over: Partial<ModelBenchRow> = {}): ModelBenchRow => ({
  runId: 'r1', spec: 'glm-5.3', questionIdx: 1, lane: 'standard', planLane: null, modelUsed: 'glm-5.3',
  ttftMs: 5000, completionMs: 9000, answered: true, empty: false, leadError: null, quality: 4,
  at: '2026-10-04T10:00:00.000Z', ...over,
});

beforeEach(() => { jest.clearAllMocks(); clearModelBenchScorecardCache(); });

describe('titles', () => {
  it('round-trips `model-bench <runId> q<idx> <spec>` (the Python bench_title twin) incl. registry specs', () => {
    // Same literal the Python self-test pins (scripts/e2e/model-bench.py).
    expect(benchTitle('mb20261004a', 3, 'cql-litellm:api-optimize-alibaba-qwen3.8-flash')).toBe('model-bench mb20261004a q3 cql-litellm:api-optimize-alibaba-qwen3.8-flash');
    expect(parseBenchTitle('model-bench mb20261004a q3 cql-litellm:api-optimize-alibaba-qwen3.8-flash')).toEqual({ runId: 'mb20261004a', questionIdx: 3, spec: 'cql-litellm:api-optimize-alibaba-qwen3.8-flash' });
    expect(parseBenchTitle(benchTitle('r-1.x_2', 12, 'glm-5.3'))).toEqual({ runId: 'r-1.x_2', questionIdx: 12, spec: 'glm-5.3' });
  });

  it('refuses any other title (a renamed chat, a bad run id, q0, extra words)', () => {
    for (const t of ['e2e suite 01-quick-weather 10:00', 'model-bench r1 q0 glm-5.3', 'model-bench r1 q1 glm 5.3', 'model-bench r/1 q1 glm-5.3', 'Weather in Toronto', '', null]) {
      expect(parseBenchTitle(t)).toBeNull();
    }
  });

  // 2026-10-20 task kinds: an OPTIONAL strict trailing `k:<kind>` token (the Python self-test pins the same literals).
  it('round-trips the optional `k:<kind>` token; `kind` is present only when the title carried a known one', () => {
    expect(benchTitle('mb20261020a', 7, 'glm-5.3', 'code')).toBe('model-bench mb20261020a q7 glm-5.3 k:code');
    expect(parseBenchTitle('model-bench mb20261020a q7 glm-5.3 k:code')).toEqual({ runId: 'mb20261020a', questionIdx: 7, spec: 'glm-5.3', kind: 'code' });
    expect(parseBenchTitle(benchTitle('r1', 2, 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', 'planning'))).toEqual({ runId: 'r1', questionIdx: 2, spec: 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', kind: 'planning' });
    // no kind / an unknown kind → no token written, no `kind` key parsed (toEqual on the exact dict)
    expect(benchTitle('r1', 1, 'glm-5.3')).toBe('model-bench r1 q1 glm-5.3');
    expect(benchTitle('r1', 1, 'glm-5.3', 'research')).toBe('model-bench r1 q1 glm-5.3');
    expect(benchTitle('r1', 1, 'glm-5.3', null)).toBe('model-bench r1 q1 glm-5.3');
    expect('kind' in parseBenchTitle('model-bench r1 q1 glm-5.3')!).toBe(false);
    // a well-formed token naming an UNKNOWN kind still parses — the row counts by lane, never dropped
    expect(parseBenchTitle('model-bench r1 q1 glm-5.3 k:research')).toEqual({ runId: 'r1', questionIdx: 1, spec: 'glm-5.3' });
    // the token is strict: anything else after the spec is still "extra words"
    for (const t of ['model-bench r1 q1 glm-5.3 k:Code', 'model-bench r1 q1 glm-5.3 k:', 'model-bench r1 q1 glm-5.3 k:code x', 'model-bench r1 q1 glm-5.3 kind:code', 'model-bench r1 q1 glm-5.3 k:co-de', 'model-bench r1 q1 glm-5.3  k:code']) {
      expect(parseBenchTitle(t)).toBeNull();
    }
  });
});

describe('picking the bench turn', () => {
  const msgs = [
    { id: 'u1', role: 'user', content: 'why is the ocean salty', createdAt: '2026-10-04T10:00:00Z' },
    { id: 'x1', role: 'assistant', content: 'Permission …', metadata: { kind: 'control_note', origin: 'agent' } },
    { id: 'v1', role: 'assistant', content: '⚠️ [ACTION VERIFIER', metadata: { verifier: 'action-verifier', origin: 'machine' } },
    { id: 'a1', role: 'assistant', content: 'Rivers carry dissolved salts…', createdAt: '2026-10-04T10:00:30Z',
      metadata: { models: { digby: { modelUsed: 'glm-5.3' } }, depth: { turnPlan: { lane: 'standard' }, plan: { preset: 'single_thinking' } }, ux: { ttftMs: 4200, completionMs: 15000 } } },
    { id: 'c1', role: 'assistant', content: '**Update to an earlier answer**', metadata: { kind: 'check_addendum' } },
  ];

  it('the first user row and the first non-side assistant row after it', () => {
    const t = pickBenchTurn(msgs)!;
    expect(t.user.id).toBe('u1');
    expect(t.answer?.id).toBe('a1');
    expect(isBenchSideRow({ kind: 'deeper_findings' })).toBe(true);
    expect(isBenchSideRow({ origin: 'deliverable_handoff' })).toBe(true);
    expect(isBenchSideRow({ origin: 'user' })).toBe(false);
  });

  it('no user row → null (never sent); a user row with no answer → answer null', () => {
    expect(pickBenchTurn([{ id: 'a', role: 'assistant', content: 'x' }])).toBeNull();
    expect(pickBenchTurn([msgs[0], msgs[4]])).toEqual({ user: msgs[0], answer: null });
  });

  it('reads lane / modelUsed / ux latency / error / time into a row', () => {
    const r = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3', chatId: 'c-1' }, pickBenchTurn(msgs)!);
    expect(r).toEqual({ runId: 'r1', spec: 'glm-5.3', questionIdx: 2, chatId: 'c-1', lane: 'standard', planLane: null, modelUsed: 'glm-5.3',
      ttftMs: 4200, completionMs: 15000, answered: true, empty: false, leadError: null, quality: null, webToolCalls: null,
      answerChars: 29, at: '2026-10-04T10:00:30.000Z' }); // judge v2 (2026-10-20): the answer's length rides the row ('Rivers carry dissolved salts…')
    const missing = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3' }, { user: msgs[0], answer: null });
    expect(missing).toMatchObject({ answered: false, empty: true, modelUsed: null, lane: null, at: null, webToolCalls: null });
    expect('answerChars' in missing).toBe(false); // no answer row → no length (never a fake 0)
  });

  // roster 2026-10-06 C-2: the answer row's web tool calls feed the picker's tool-aware latency model.
  it('counts web tool calls in the answer parts; null when parts were not read (legacy ingest)', () => {
    const parts = [
      { type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine' },
      { type: 'tool_call', name: 'scrape_as_markdown' }, { type: 'tool_call', name: 'search_memory' },
      { type: 'tool_call', name: 'web_pipe' }, { type: 'text', text: 'x' }, null,
    ];
    expect(countBenchWebToolCalls(parts)).toBe(3);
    expect(countBenchWebToolCalls([])).toBe(0);
    expect(countBenchWebToolCalls(undefined)).toBeNull();
    expect(countBenchWebToolCalls('nope')).toBeNull();
    expect([...BENCH_WEB_TOOL_NAMES].sort()).toEqual(['browser_task', 'scrape_as_html', 'scrape_as_markdown', 'scrape_batch', 'search_engine', 'web_pipe', 'youtube_pipe']);
    const withParts = [msgs[0], { ...msgs[3], parts }];
    expect(benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3' }, pickBenchTurn(withParts)!).webToolCalls).toBe(3);
  });

  // 2026-10-20 task kinds: the title kind and the answer's classified kind (turnPlan.taskKind.kind) ride the row.
  it('carries the title kind and the classified planKind (each only when present and a known kind)', () => {
    const stamped = (kind: unknown) => [msgs[0], { ...msgs[3], metadata: { ...msgs[3].metadata, depth: { turnPlan: { lane: 'standard', taskKind: { kind, top: 'code', p: 0.91, usable: true } }, plan: {} } } }];
    const r = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3', kind: 'code' }, pickBenchTurn(stamped('code'))!);
    expect(r).toMatchObject({ kind: 'code', planKind: 'code', lane: 'standard' });
    expect(benchRowKind(r)).toBe('code');
    const disagree = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3', kind: 'writing' }, pickBenchTurn(stamped('explain'))!);
    expect(benchRowKind(disagree)).toBe('writing'); // the title kind wins (every model's chat of a question shares it)
    const planOnly = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3' }, pickBenchTurn(stamped('planning'))!);
    expect('kind' in planOnly).toBe(false);
    expect(benchRowKind(planOnly)).toBe('planning'); // no title kind → the classified kind
    for (const bad of [null, 'research', 7, undefined]) {
      const row = benchRowFromTurn({ runId: 'r1', questionIdx: 2, spec: 'glm-5.3' }, pickBenchTurn(stamped(bad))!);
      expect('planKind' in row).toBe(false);
      expect(benchRowKind(row)).toBeNull();
    }
    expect(benchRowKind({ kind: 'bogus' as any, planKind: 'lookup' })).toBe('lookup');
  });
});

describe('attribution', () => {
  it('measured only when the spec led; Quick diversion + unknown leader excluded; failures and failovers count against the spec', () => {
    expect(attributeBenchRow(row())).toBe('measured');
    expect(attributeBenchRow(row({ modelUsed: 'cql-litellm:qwen3.8-flash', planLane: 'quick', lane: 'quick' }))).toBe('diverted');
    expect(attributeBenchRow(row({ modelUsed: 'cql-litellm:qwen3.8-flash', planLane: 'quick', leadError: 'empty' }))).toBe('diverted');
    expect(attributeBenchRow(row({ answered: false, modelUsed: null, empty: true }))).toBe('failed');
    expect(attributeBenchRow(row({ empty: true }))).toBe('failed');
    expect(attributeBenchRow(row({ leadError: 'glm-5.3 returned no output' }))).toBe('failed');
    expect(attributeBenchRow(row({ modelUsed: 'kimi-k3' }))).toBe('failover');
    expect(attributeBenchRow(row({ modelUsed: null }))).toBe('unverified');
  });
});

describe('aggregateBenchRows', () => {
  it('per spec per lane + all: n, latency percentiles over MEASURED rows, failRate over attributable rows, quality mean', () => {
    const rows = [
      row({ questionIdx: 1, ttftMs: 1000, completionMs: 4000, quality: 5 }),
      row({ questionIdx: 2, ttftMs: 3000, completionMs: 8000, quality: 3 }),
      row({ questionIdx: 3, lane: 'checked', ttftMs: 9000, completionMs: 30000, quality: null, at: '2026-10-04T11:00:00.000Z' }),
      row({ questionIdx: 4, lane: 'checked', modelUsed: 'kimi-k3', ttftMs: 1, quality: 5 }), // failover: a failure, no latency / quality
      row({ questionIdx: 5, lane: 'quick', planLane: 'quick', modelUsed: 'qwen3.8-flash' }), // diverted: left out
      row({ questionIdx: 6, lane: null, answered: false, empty: true, modelUsed: null, ttftMs: null, completionMs: null, quality: null, at: null }),
      row({ spec: 'deepseek-flash', modelUsed: 'deepseek-flash', ttftMs: 2000, completionMs: 6000, quality: 4 }),
      row({ spec: 'cql-litellm:x', lane: 'quick', planLane: 'quick', modelUsed: 'qwen3.8-flash' }), // all diverted → spec omitted
    ];
    const card = aggregateBenchRows(rows, { runId: 'r1', now: new Date('2026-10-04T12:00:00Z') });
    expect(card.updatedAt).toBe('2026-10-04T12:00:00.000Z');
    expect(card.updatedBy).toBe('model-bench-ingest');
    expect(card.runs).toEqual(['r1']);
    expect(Object.keys(card.models)).toEqual(['deepseek-flash', 'glm-5.3']);
    const g = card.models['glm-5.3'].lanes;
    expect(Object.keys(g)).toEqual(['all', 'checked', 'none', 'standard']);
    expect(g.all).toEqual({ n: 5, ttftP50Ms: 3000, ttftP90Ms: 9000, doneP50Ms: 8000, failRate: 0.4, quality: 4, qualityN: 2, runId: 'r1', at: '2026-10-04T11:00:00.000Z' });
    expect(g.standard).toMatchObject({ n: 2, ttftP50Ms: 3000, failRate: 0, quality: 4, qualityN: 2 });
    expect(g.checked).toMatchObject({ n: 2, ttftP50Ms: 9000, ttftP90Ms: 9000, failRate: 0.5, quality: null, qualityN: 0 });
    expect(g.none).toMatchObject({ n: 1, ttftP50Ms: null, doneP50Ms: null, failRate: 1, quality: null });
    expect(g.quick).toBeUndefined();
    expect(card.models['deepseek-flash'].lanes.all).toMatchObject({ n: 1, ttftP50Ms: 2000, quality: 4 });
  });

  it('webToolsMean = mean over MEASURED rows that carry a count; absent when none did (old buckets unchanged)', () => {
    const rows = [
      row({ questionIdx: 1, webToolCalls: 2 }),
      row({ questionIdx: 2, webToolCalls: 0 }),
      row({ questionIdx: 3, webToolCalls: null }), // parts not read — not in the mean
      row({ questionIdx: 4, modelUsed: 'kimi-k3', webToolCalls: 9 }), // failover — never measured
      row({ questionIdx: 5, lane: 'checked', webToolCalls: 1 }),
    ];
    const g = aggregateBenchRows(rows, { runId: 'r1' }).models['glm-5.3'].lanes;
    expect(g.all.webToolsMean).toBe(1);
    expect(g.standard.webToolsMean).toBe(1);
    expect(g.checked.webToolsMean).toBe(1);
    const legacy = aggregateBenchRows([row()], { runId: 'r1' }).models['glm-5.3'].lanes.all;
    expect('webToolsMean' in legacy).toBe(false);
    expect(aggregateBenchRows([row({ webToolCalls: 1 }), row({ questionIdx: 2, webToolCalls: 2 })], { runId: 'r1' }).models['glm-5.3'].lanes.all.webToolsMean).toBe(1.5);
  });

  it('normalize round-trips webToolsMean and leaves an old bucket without the key', () => {
    const base = { n: 2, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4, qualityN: 2, runId: 'r1', at: 'a' };
    const card = normalizeScorecard({ models: { m: { lanes: { all: { ...base, webToolsMean: 1.25 }, standard: base, checked: { ...base, webToolsMean: 'x' } } } } })!;
    expect(card.models.m.lanes.all.webToolsMean).toBe(1.25);
    expect('webToolsMean' in card.models.m.lanes.standard).toBe(false);
    expect(card.models.m.lanes.checked.webToolsMean).toBeNull();
    expect(mergeScorecards(null, card).models.m.lanes.all.webToolsMean).toBe(1.25);
  });

  // judge v2 (2026-10-20): the median answer length and the judge stamp ride the buckets — each only when present.
  it('answerCharsP50 = the median answer length over MEASURED rows that carry one; qualityJudge stamps JUDGED buckets only; both absent otherwise', () => {
    const rows = [
      row({ questionIdx: 1, answerChars: 1000, quality: 5, kind: 'code' }),
      row({ questionIdx: 2, answerChars: 3000, quality: 3, kind: 'code' }),
      row({ questionIdx: 3, answerChars: 2000, quality: 1 }),
      row({ questionIdx: 4, modelUsed: 'kimi-k3', answerChars: 99999 }), // failover — never measured, never in the median
      row({ questionIdx: 5, lane: 'checked', answerChars: 400, quality: null }), // measured, unjudged
    ];
    const card = aggregateBenchRows(rows, { runId: 'r1', qualityJudge: 'v2:2x2' }).models['glm-5.3'];
    expect(card.lanes.all).toMatchObject({ answerCharsP50: 2000, quality: 3, qualityN: 3, qualityJudge: 'v2:2x2' });
    expect(card.lanes.standard).toMatchObject({ answerCharsP50: 2000, qualityJudge: 'v2:2x2' });
    expect(card.lanes.checked).toMatchObject({ answerCharsP50: 400, quality: null });
    expect('qualityJudge' in card.lanes.checked).toBe(false); // nothing judged → no stamp
    expect(card.kinds!.code).toMatchObject({ answerCharsP50: 3000, qualityJudge: 'v2:2x2', fieldSize: 1 }); // nearest-rank p50 of [1000, 3000] (the upper one — benchPercentile's rule)
    // no lengths, no stamp → the pre-v2 bucket shape exactly (the v1 ingest and an older leaf)
    const plain = aggregateBenchRows([row()], { runId: 'r1' }).models['glm-5.3'].lanes.all;
    expect('answerCharsP50' in plain).toBe(false);
    expect('qualityJudge' in plain).toBe(false);
    // a malformed stamp is never written
    expect('qualityJudge' in aggregateBenchRows([row()], { runId: 'r1', qualityJudge: 'v2 two judges' }).models['glm-5.3'].lanes.all).toBe(false);
  });

  it('normalize carries answerCharsP50 + qualityJudge when stored (malformed stamp dropped), and leaves an old bucket without them', () => {
    const base = { n: 2, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4, qualityN: 2, runId: 'r1', at: 'a' };
    const card = normalizeScorecard({ models: { m: {
      lanes: { all: { ...base, answerCharsP50: 2100, qualityJudge: 'v2:2x2+lc' }, standard: base, checked: { ...base, answerCharsP50: 'x', qualityJudge: { v: 2 } } },
      kinds: { code: { ...base, fieldSize: 3, answerCharsP50: 900, qualityJudge: 'v2:3x2' } } } } })!;
    expect(card.models.m.lanes.all).toMatchObject({ answerCharsP50: 2100, qualityJudge: 'v2:2x2+lc' });
    expect(card.models.m.lanes.standard).toEqual(base);
    expect(card.models.m.lanes.checked.answerCharsP50).toBeNull();
    expect('qualityJudge' in card.models.m.lanes.checked).toBe(false);
    expect(card.models.m.kinds!.code).toMatchObject({ answerCharsP50: 900, qualityJudge: 'v2:3x2', fieldSize: 3 });
    expect(mergeScorecards(null, card).models.m.lanes.all).toMatchObject({ answerCharsP50: 2100, qualityJudge: 'v2:2x2+lc' });
  });

  // 2026-10-20 task kinds: models[spec].kinds[kind] (laneStats + the kind's field size); absent with no kind rows.
  it('builds kinds[kind] per spec (title kind, else planKind) with fieldSize; lanes unchanged; absent when no row has a kind', () => {
    const rows = [
      row({ questionIdx: 1, kind: 'code', ttftMs: 1000, completionMs: 4000, quality: 5 }),
      row({ questionIdx: 2, kind: 'code', ttftMs: 3000, completionMs: 8000, quality: 3, at: '2026-10-04T11:00:00.000Z' }),
      row({ questionIdx: 3, planKind: 'writing', quality: 4 }), // no title kind → the classified kind
      row({ questionIdx: 4, kind: 'writing', modelUsed: 'kimi-k3', quality: 5 }), // failover: counts in n / failRate only
      row({ questionIdx: 5, quality: 2 }), // no kind at all → lanes only
      row({ questionIdx: 6, kind: 'lookup', lane: 'quick', planLane: 'quick', modelUsed: 'qwen3.8-flash' }), // diverted: left out
      row({ spec: 'deepseek-flash', modelUsed: 'deepseek-flash', questionIdx: 1, kind: 'code', quality: 1 }),
      row({ spec: 'deepseek-flash', modelUsed: 'deepseek-flash', questionIdx: 3, kind: 'writing', answered: false, empty: true }), // failed: not in the field
      row({ spec: 'kimi-k3', modelUsed: 'kimi-k3', questionIdx: 5, quality: 3 }),
    ];
    const card = aggregateBenchRows(rows, { runId: 'r1' });
    const g = card.models['glm-5.3'];
    expect(Object.keys(g.lanes)).toEqual(['all', 'standard']);
    expect(g.lanes.all).toMatchObject({ n: 5, qualityN: 4 }); // the lane buckets see every row exactly as before
    expect(Object.keys(g.kinds!)).toEqual(['code', 'writing']); // no lookup bucket — the diverted row is left out
    expect(g.kinds!.code).toEqual({ n: 2, ttftP50Ms: 3000, ttftP90Ms: 3000, doneP50Ms: 8000, failRate: 0, quality: 4, qualityN: 2, runId: 'r1', at: '2026-10-04T11:00:00.000Z', fieldSize: 2 });
    expect(g.kinds!.writing).toMatchObject({ n: 2, failRate: 0.5, quality: 4, qualityN: 1, fieldSize: 1 }); // deepseek failed writing → field 1
    expect(card.models['deepseek-flash'].kinds).toEqual({
      code: expect.objectContaining({ n: 1, quality: 1, fieldSize: 2 }),
      writing: expect.objectContaining({ n: 1, failRate: 1, quality: null, fieldSize: 1 }),
    });
    expect('kinds' in card.models['kimi-k3']).toBe(false); // a kind-less spec keeps the pre-kind card shape
    expect(card.models['kimi-k3']).toEqual({ lanes: { all: expect.any(Object), standard: expect.any(Object) } });
    // no kind anywhere → byte-identical to the pre-kind aggregate (no kinds key on any card)
    const plain = aggregateBenchRows([row(), row({ questionIdx: 2, spec: 'deepseek-flash', modelUsed: 'deepseek-flash' })], { runId: 'r1' });
    expect(Object.values(plain.models).every((m) => !('kinds' in m))).toBe(true);
  });

  it('nearest-rank percentiles (the live-chat audit rule); empty input', () => {
    expect(benchPercentile([5, 1, 3, null, NaN as any], 0.5)).toBe(3);
    expect(benchPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(benchPercentile([], 0.5)).toBeNull();
    const empty = aggregateBenchRows([], { now: new Date('2026-10-04T00:00:00Z') });
    expect(empty).toEqual({ updatedAt: '2026-10-04T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: [], models: {} });
  });
});

describe('mergeScorecards', () => {
  const stats = (runId: string, at: string, n = 3) => ({ n, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4, qualityN: n, runId, at });
  const prev: ModelBenchScorecard = {
    updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['r0'],
    models: {
      'glm-5.3': { lanes: { all: stats('r0', '2026-10-01T00:00:00.000Z'), standard: stats('r0', '2026-10-01T00:00:00.000Z'), research: stats('r0', '2026-10-01T00:00:00.000Z') } },
      'kimi-k3': { lanes: { all: stats('r0', '2026-10-01T00:00:00.000Z') } },
    },
  };

  it('a newer run REPLACES the same spec + lane bucket; other buckets and specs are kept; runs unioned', () => {
    const next: ModelBenchScorecard = { updatedAt: '2026-10-04T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['r1'],
      models: { 'glm-5.3': { lanes: { all: stats('r1', '2026-10-04T00:00:00.000Z', 9), standard: stats('r1', '2026-10-04T00:00:00.000Z', 9) } }, 'deepseek-flash': { lanes: { all: stats('r1', '2026-10-04T00:00:00.000Z') } } } };
    const m = mergeScorecards(prev, next);
    expect(m.updatedAt).toBe('2026-10-04T00:00:00.000Z');
    expect(m.runs).toEqual(['r0', 'r1']);
    expect(m.models['glm-5.3'].lanes.all.runId).toBe('r1');
    expect(m.models['glm-5.3'].lanes.standard.n).toBe(9);
    expect(m.models['glm-5.3'].lanes.research.runId).toBe('r0');
    expect(m.models['kimi-k3'].lanes.all.runId).toBe('r0');
    expect(m.models['deepseek-flash'].lanes.all.runId).toBe('r1');
  });

  it('re-ingesting an OLDER run never clobbers a newer bucket; no prev = next; malformed prev buckets dropped', () => {
    const old: ModelBenchScorecard = { updatedAt: '2026-10-05T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['rOld'],
      models: { 'glm-5.3': { lanes: { all: stats('rOld', '2026-09-20T00:00:00.000Z') } } } };
    expect(mergeScorecards(prev, old).models['glm-5.3'].lanes.all.runId).toBe('r0');
    expect(mergeScorecards(null, old)).toEqual(old);
    const bad = { ...prev, models: { 'glm-5.3': { lanes: { all: { n: 'x' }, standard: stats('r0', '2026-10-01T00:00:00.000Z') } } } } as any;
    expect(Object.keys(mergeScorecards(bad, old).models['glm-5.3'].lanes)).toEqual(['standard', 'all']);
  });

  it(`caps the run list at ${MODEL_BENCH_MAX_RUNS} (oldest dropped)`, () => {
    const many = { ...prev, runs: Array.from({ length: MODEL_BENCH_MAX_RUNS }, (_, i) => `r${i}`) };
    const m = mergeScorecards(many, { updatedAt: 'x', updatedBy: 'y', runs: ['rNew'], models: {} });
    expect(m.runs).toHaveLength(MODEL_BENCH_MAX_RUNS);
    expect(m.runs[0]).toBe('r1');
    expect(m.runs[m.runs.length - 1]).toBe('rNew');
  });

  // 2026-10-20 task kinds: normalize + merge CARRY kinds (an old normalize rebuilt {lanes} only and erased them).
  it('normalize keeps kind buckets (fieldSize too) and a model with kinds but no lanes; malformed kind buckets dropped', () => {
    const k = { ...stats('rk', '2026-10-20T00:00:00.000Z', 8), fieldSize: 3 };
    const card = normalizeScorecard({ models: {
      'glm-5.3': { lanes: { all: stats('r0', '2026-10-01T00:00:00.000Z') }, kinds: { code: k, writing: { n: 'x' }, 'Not A Kind': k, future: { ...k, fieldSize: 'x' } } },
      'kimi-k3': { kinds: { planning: k } }, // kinds only — kept
      'qwen3.6-27b': { lanes: {}, kinds: {} }, // nothing → dropped
    } })!;
    expect(Object.keys(card.models)).toEqual(['glm-5.3', 'kimi-k3']);
    expect(Object.keys(card.models['glm-5.3'].kinds!)).toEqual(['code', 'future']); // a later vocabulary's key survives a read
    expect(card.models['glm-5.3'].kinds!.code).toEqual(k);
    expect(card.models['glm-5.3'].kinds!.future.fieldSize).toBeNull();
    expect(card.models['kimi-k3']).toEqual({ lanes: {}, kinds: { planning: k } });
    expect('kinds' in normalizeScorecard(prev)!.models['glm-5.3']).toBe(false); // a kind-less card keeps its shape
  });

  it('merge: a newer kind bucket REPLACES the same spec + kind; an older one never clobbers; other kinds / lanes kept', () => {
    const kb = (runId: string, at: string, n = 8, fieldSize = 3) => ({ ...stats(runId, at, n), fieldSize });
    const withKinds: ModelBenchScorecard = { ...prev, models: { ...prev.models,
      'glm-5.3': { ...prev.models['glm-5.3'], kinds: { code: kb('rk', '2026-10-10T00:00:00.000Z'), writing: kb('rk', '2026-10-10T00:00:00.000Z') } } } };
    const next: ModelBenchScorecard = { updatedAt: '2026-10-20T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['rk2'],
      models: {
        'glm-5.3': { lanes: { all: stats('rk2', '2026-10-20T00:00:00.000Z', 10) }, kinds: { code: kb('rk2', '2026-10-20T00:00:00.000Z', 10, 5), planning: kb('rk2', '2026-10-20T00:00:00.000Z') } },
        'deepseek-flash': { lanes: {}, kinds: { code: kb('rk2', '2026-10-20T00:00:00.000Z') } },
      } };
    const m = mergeScorecards(withKinds, next);
    const g = m.models['glm-5.3'];
    expect(g.kinds!.code).toMatchObject({ runId: 'rk2', n: 10, fieldSize: 5 });
    expect(g.kinds!.writing.runId).toBe('rk'); // untouched kind kept
    expect(g.kinds!.planning.runId).toBe('rk2');
    expect(g.lanes.research.runId).toBe('r0');
    expect(m.models['deepseek-flash'].kinds!.code.runId).toBe('rk2'); // a model with kinds but no lanes is merged in
    expect('kinds' in m.models['kimi-k3']).toBe(false);
    // a re-ingest of an OLDER kind run never clobbers the newer bucket
    const older: ModelBenchScorecard = { updatedAt: 'x', updatedBy: 'y', runs: ['rOld'], models: { 'glm-5.3': { lanes: {}, kinds: { code: kb('rOld', '2026-09-01T00:00:00.000Z') } } } };
    expect(mergeScorecards(m, older).models['glm-5.3'].kinds!.code.runId).toBe('rk2');
    // a kind-less merge leaves the stored kinds alone (a lane-only run never erases a kind bucket)
    const laneOnly: ModelBenchScorecard = { updatedAt: 'x', updatedBy: 'y', runs: ['rL'], models: { 'glm-5.3': { lanes: { all: stats('rL', '2026-10-21T00:00:00.000Z') } } } };
    expect(mergeScorecards(m, laneOnly).models['glm-5.3'].kinds).toEqual(g.kinds);
    // the stored kinds survive a full ingest-shaped round trip (raw → normalize → merge with an aggregate)
    const agg = aggregateBenchRows([row({ kind: 'explain', at: '2026-10-22T00:00:00.000Z' })], { runId: 'r9' });
    const rt = mergeScorecards(normalizeScorecard(JSON.parse(JSON.stringify(m))), agg);
    expect(Object.keys(rt.models['glm-5.3'].kinds!).sort()).toEqual(['code', 'explain', 'planning', 'writing']);
  });

  // 2026-10-20 review, finding A: the ingest leaves singleton questions UNJUDGED, so a run whose questions were all
  // singletons (or a --no-judge ingest) merges quality-null buckets — newer-`at`-wins used to wipe the judged quality
  // and the pick read "seat unmeasured". Judged quality now survives; the newer latency / n / failRate still land.
  it('a bucket with NO judged quality never erases a stored judged quality (lanes AND kinds); the newer latency / n / failRate / runId / at still land', () => {
    const judged = (runId: string, at: string, quality: number, qualityN: number) => ({ ...stats(runId, at, qualityN), quality, qualityN });
    const unjudged = (runId: string, at: string, over: Record<string, unknown> = {}) => ({ n: 5, ttftP50Ms: 999, ttftP90Ms: 1999, doneP50Ms: 2999, failRate: 0.2, quality: null, qualityN: 0, webToolsMean: 1.5, runId, at, ...over });
    const stored: ModelBenchScorecard = { updatedAt: 'x', updatedBy: 'model-bench-ingest', runs: ['r0'], models: {
      'glm-5.3': { lanes: { all: judged('r0', '2026-10-01T00:00:00.000Z', 4.25, 4), standard: judged('r0', '2026-10-01T00:00:00.000Z', 3.5, 2), none: { ...unjudged('r0', '2026-10-01T00:00:00.000Z'), n: 1 } },
        kinds: { code: { ...judged('r0', '2026-10-01T00:00:00.000Z', 4, 3), fieldSize: 3 } } } } };
    const next: ModelBenchScorecard = { updatedAt: 'y', updatedBy: 'model-bench-ingest', runs: ['r2'], models: {
      'glm-5.3': { lanes: { all: unjudged('r2', '2026-10-20T00:00:00.000Z'), standard: unjudged('r2', '2026-10-20T00:00:00.000Z', { quality: 2, qualityN: 0 }), none: unjudged('r2', '2026-10-20T00:00:00.000Z') },
        kinds: { code: { ...unjudged('r2', '2026-10-20T00:00:00.000Z'), fieldSize: 1 } } } } };
    const g = mergeScorecards(stored, next).models['glm-5.3'];
    // the judged quality + its count carried; everything else from the newer run
    expect(g.lanes.all).toEqual({ ...unjudged('r2', '2026-10-20T00:00:00.000Z'), quality: 4.25, qualityN: 4 });
    // a finite score with qualityN 0 is not judged either — the stored judged quality wins
    expect(g.lanes.standard).toMatchObject({ quality: 3.5, qualityN: 2, n: 5, runId: 'r2' });
    // nothing judged on either side → the newer bucket as-is
    expect(g.lanes.none).toEqual(unjudged('r2', '2026-10-20T00:00:00.000Z'));
    // a (thin) kind bucket: the same rule; fieldSize is the newer run's
    expect(g.kinds!.code).toEqual({ ...unjudged('r2', '2026-10-20T00:00:00.000Z'), quality: 4, qualityN: 3, fieldSize: 1 });
    // a JUDGED newer bucket still replaces the stored quality (a low score is evidence, never "unjudged")
    const rejudged = mergeScorecards(stored, { ...next, models: { 'glm-5.3': { lanes: { all: judged('r3', '2026-10-21T00:00:00.000Z', 1, 1) } } } });
    expect(rejudged.models['glm-5.3'].lanes.all).toMatchObject({ quality: 1, qualityN: 1, runId: 'r3' });
    // an OLDER unjudged re-ingest never touches the stored bucket at all (newer-`at` first)
    const old = mergeScorecards(stored, { ...next, models: { 'glm-5.3': { lanes: { all: unjudged('rOld', '2026-09-01T00:00:00.000Z') } } } });
    expect(old.models['glm-5.3'].lanes.all).toEqual(stored.models['glm-5.3'].lanes.all);
    // the review's shape end to end: an all-singleton run aggregates to quality-null buckets → judged quality survives
    const singletons = aggregateBenchRows([row({ quality: null, at: '2026-10-22T00:00:00.000Z' }), row({ questionIdx: 2, quality: null, ttftMs: 7000, at: '2026-10-22T00:00:00.000Z' })], { runId: 'r4' });
    const m = mergeScorecards(stored, singletons).models['glm-5.3'].lanes;
    expect(m.all).toMatchObject({ quality: 4.25, qualityN: 4, n: 2, ttftP50Ms: 7000, runId: 'r4', at: '2026-10-22T00:00:00.000Z' });
    expect(m.standard).toMatchObject({ quality: 3.5, qualityN: 2, runId: 'r4' });
  });

  // judge v2 (2026-10-20): a quality kept by the never-erase rule keeps the stamp of the judge that ranked it.
  it('the never-erase rule keeps the stored qualityJudge with the stored quality; a judged newer bucket brings its own stamp (or none)', () => {
    const at0 = '2026-10-01T00:00:00.000Z', at1 = '2026-10-20T00:00:00.000Z';
    const v2 = { ...stats('r0', at0, 6), quality: 3.4, qualityN: 6, qualityJudge: 'v2:2x2' };
    const stored: ModelBenchScorecard = { updatedAt: 'x', updatedBy: 'model-bench-ingest', runs: ['r0'], models: { 'glm-5.3': { lanes: { all: v2 } } } };
    const unjudged = { ...stats('r1', at1, 0), quality: null, qualityN: 0, answerCharsP50: 1800 };
    const kept = mergeScorecards(stored, { ...stored, runs: ['r1'], models: { 'glm-5.3': { lanes: { all: unjudged } } } }).models['glm-5.3'].lanes.all;
    expect(kept).toEqual({ ...unjudged, quality: 3.4, qualityN: 6, qualityJudge: 'v2:2x2' });
    // a judged v1 bucket (no stamp) replaces a v2 one whole — the stamp never sticks to a quality it did not rank
    const v1 = { ...stats('r2', at1, 4), quality: 4.5, qualityN: 4 };
    const replaced = mergeScorecards(stored, { ...stored, runs: ['r2'], models: { 'glm-5.3': { lanes: { all: v1 } } } }).models['glm-5.3'].lanes.all;
    expect(replaced).toEqual(v1);
    // an unjudged refresh over an UNSTAMPED judged bucket adds no stamp
    const plain = mergeScorecards({ ...stored, models: { 'glm-5.3': { lanes: { all: v1 } } } }, { ...stored, runs: ['r3'], models: { 'glm-5.3': { lanes: { all: { ...unjudged, at: '2026-10-21T00:00:00.000Z' } } } } }).models['glm-5.3'].lanes.all;
    expect('qualityJudge' in plain).toBe(false);
    expect(plain).toMatchObject({ quality: 4.5, qualityN: 4, answerCharsP50: 1800 });
  });

  // 2026-10-20 review, finding B: a routine refresh files 1–4 rows per (spec, kind) (the classified planKind keys a
  // bucket even without a title token) — that thin bucket must never REPLACE the deep one a dedicated kind run built.
  it(`a THIN kind bucket (< KIND_BUCKET_KEEP_MIN_N judged) never replaces a DEEP one; deep / thin-over-thin still replace; lanes are not floored`, () => {
    expect(KIND_BUCKET_KEEP_MIN_N).toBe(8);
    const kb = (runId: string, at: string, qualityN: number, quality: number | null = 4) => ({ ...stats(runId, at, qualityN), quality, fieldSize: 3 });
    const T1 = '2026-10-10T00:00:00.000Z';
    const T2 = '2026-10-20T00:00:00.000Z';
    const stored: ModelBenchScorecard = { updatedAt: 'x', updatedBy: 'model-bench-ingest', runs: ['rk'], models: {
      'glm-5.3': { lanes: { all: stats('rk', T1, 70), standard: stats('rk', T1, 10) },
        kinds: { code: kb('rk', T1, 10), writing: kb('rk', T1, KIND_BUCKET_KEEP_MIN_N), planning: kb('rk', T1, 5), explain: kb('rk', T1, 9, null), lookup: kb('rk', T1, 12) } } } };
    const next: ModelBenchScorecard = { updatedAt: 'y', updatedBy: 'model-bench-ingest', runs: ['r12'], models: {
      'glm-5.3': { lanes: { all: stats('r12', T2, 2), standard: stats('r12', T2, 1) },
        kinds: {
          code: kb('r12', T2, 3), // thin over deep → the deep one stays WHOLE
          writing: kb('r12', T2, 2, 1), // thin over a bucket exactly at the floor → kept too
          planning: kb('r12', T2, 2, 1), // thin over thin → the newer replaces
          explain: kb('r12', T2, 1, 2), // the stored "deep" one has a count but no score — not judged, so not deep
          lookup: kb('r12', T2, 9, null), // a count without a score is not judged → thin → the deep one stays
        } } } };
    const m = mergeScorecards(stored, next).models['glm-5.3'];
    expect(m.kinds!.code).toEqual(stored.models['glm-5.3'].kinds!.code);
    expect(m.kinds!.writing.runId).toBe('rk');
    expect(m.kinds!.planning).toMatchObject({ runId: 'r12', quality: 1, qualityN: 2 });
    expect(m.kinds!.explain).toMatchObject({ runId: 'r12', quality: 2, qualityN: 1 });
    expect(m.kinds!.lookup).toEqual(stored.models['glm-5.3'].kinds!.lookup);
    // lane buckets have no floor: the newer (thin) run replaces as before
    expect(m.lanes.all).toMatchObject({ runId: 'r12', qualityN: 2 });
    expect(m.lanes.standard).toMatchObject({ runId: 'r12', qualityN: 1 });
    // a DEEP incoming bucket (at the floor or above) replaces a deep stored one
    const deep = mergeScorecards(stored, { ...next, models: { 'glm-5.3': { lanes: {}, kinds: { code: kb('rk2', T2, KIND_BUCKET_KEEP_MIN_N, 2), lookup: kb('rk2', T2, 20, 3) } } } });
    expect(deep.models['glm-5.3'].kinds!.code).toMatchObject({ runId: 'rk2', quality: 2, qualityN: KIND_BUCKET_KEEP_MIN_N });
    expect(deep.models['glm-5.3'].kinds!.lookup).toMatchObject({ runId: 'rk2', qualityN: 20 });
    // a routine run end to end: aggregated thin kind rows (planKind only, judged) leave the deep kind bucket alone
    const routine = aggregateBenchRows([row({ planKind: 'code', quality: 1, at: '2026-10-22T00:00:00.000Z' }), row({ questionIdx: 2, planKind: 'writing', quality: 5, at: '2026-10-22T00:00:00.000Z' })], { runId: 'r13' });
    const rt = mergeScorecards(stored, routine).models['glm-5.3'];
    expect(rt.kinds!.code.runId).toBe('rk');
    expect(rt.kinds!.writing.runId).toBe('rk');
    expect(rt.lanes.all.runId).toBe('r13');
  });

  it('KIND_BUCKET_KEEP_MIN_N mirrors the picker\'s usable kind-bucket floor (model-evidence.ts BENCH_KIND_MIN_N)', () => {
    expect(KIND_BUCKET_KEEP_MIN_N).toBe(BENCH_KIND_MIN_N);
  });

  it('normalizeScorecard rejects a non-scorecard', () => {
    expect(normalizeScorecard(null)).toBeNull();
    expect(normalizeScorecard({ updatedAt: 'x' })).toBeNull();
    expect(normalizeScorecard({ models: {} })).toEqual({ updatedAt: '', updatedBy: '', runs: [], models: {} });
  });
});

describe('readModelBenchScorecard', () => {
  it('reads [instance, model-bench] / scorecard, normalized; absent → null; a store failure → null (never throws)', async () => {
    mockStoreGet.mockResolvedValueOnce({ updatedAt: 'u', updatedBy: 'model-bench-ingest', runs: ['r1'], models: { 'glm-5.3': { lanes: { all: { n: 2, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4.5, qualityN: 2, runId: 'r1', at: 'a' } } } } });
    const card = await readModelBenchScorecard();
    expect(mockStoreGet).toHaveBeenCalledWith(MODEL_BENCH_STORE_NS, MODEL_BENCH_STORE_KEY);
    expect(MODEL_BENCH_STORE_NS).toEqual(['instance', 'model-bench']);
    expect(card?.models['glm-5.3'].lanes.all.quality).toBe(4.5);
    mockStoreGet.mockResolvedValueOnce(null);
    expect(await readModelBenchScorecard({ fresh: true })).toBeNull();
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    expect(await readModelBenchScorecard({ fresh: true })).toBeNull();
  });

  it('caches 60 s per process; fresh bypasses', async () => {
    mockStoreGet.mockResolvedValue({ models: {} });
    await readModelBenchScorecard();
    await readModelBenchScorecard();
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    await readModelBenchScorecard({ fresh: true });
    expect(mockStoreGet).toHaveBeenCalledTimes(2);
    mockStoreGet.mockReset();
  });
});
