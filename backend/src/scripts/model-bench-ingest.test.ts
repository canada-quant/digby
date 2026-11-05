/**
 * scripts/framework-audit/model-bench-ingest.js — the offline model bench's ingest (2026-10-04), driven through its
 * injectable run() with the REAL scorecard leaf and a MOCKED Prisma / context store / quality judge: the run's chats
 * are selected by title prefix (the run-id boundary included), side rows skipped, only MEASURED answers judged, the
 * scorecard aggregated by the leaf and MERGED into the store row only with --apply; --cleanup needs --apply; a store
 * read failure writes nothing; the result never carries question or answer text.
 */
import path from 'path';
import * as leaf from '../modules/crossmodel/platform/model-bench-scorecard';

const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'model-bench-ingest.js'));
// Judge v2 is the default since 2026-10-20: the suites below that pin the single v1 judge pass --judge-version v1 (the
// restore path — their pins are unchanged, which is the v1 identity check); the v2 suites at the end run the default.
const V1 = ['--judge-version', 'v1'];

const answer = (id: string, modelUsed: string, extra: Record<string, any> = {}, content = 'An answer.') => ({
  id, role: 'assistant', content, createdAt: new Date('2026-10-04T10:00:30Z'),
  metadata: { models: { digby: { modelUsed, ...(extra.error ? { error: extra.error } : {}) } }, depth: { turnPlan: { lane: extra.lane ?? 'standard' }, plan: { preset: 'single_thinking', ...(extra.planLane ? { lane: extra.planLane } : {}) } }, ux: { ttftMs: extra.ttft ?? 4000, completionMs: extra.done ?? 12000 } },
});
const user = (id: string, content: string) => ({ id, role: 'user', content, createdAt: new Date('2026-10-04T10:00:00Z'), metadata: null });

function fixtures() {
  const chats = [
    { id: 'c1', title: 'model-bench mb1 q1 glm-5.3' },
    { id: 'c2', title: 'model-bench mb1 q1 deepseek-flash' },
    { id: 'c3', title: 'model-bench mb1 q2 glm-5.3' },
    { id: 'c4', title: 'model-bench mb1 q2 deepseek-flash' },
    { id: 'c5', title: 'model-bench mb1 preflight' },
    { id: 'c6', title: 'model-bench mb1 q3 glm-5.3' },
    { id: 'c7', title: 'model-bench mb10 q1 glm-5.3' }, // another run: the prefix carries the trailing space
    { id: 'c8', title: 'model-bench mb1 q3 deepseek-flash' },
    { id: 'c9', title: 'why is the ocean salty' },
  ];
  const messages: Record<string, any[]> = {
    c1: [user('u1', 'why is the ocean salty'), answer('a1', 'glm-5.3', {}, 'A great answer about rivers and salt.')],
    c2: [user('u2', 'why is the ocean salty'), answer('a2', 'deepseek-flash', { ttft: 2000 }, 'Rivers carry salts.')],
    c3: [user('u3', 'is it gonna rain in Toronto tomorrow'), answer('a3', 'cql-litellm:qwen3.8-flash', { lane: 'quick', planLane: 'quick' })],
    c4: [user('u4', 'is it gonna rain in Toronto tomorrow'), answer('a4', 'kimi-k3', { lane: 'checked' })],
    c6: [],
    c7: [user('u7', 'x'), answer('a7', 'glm-5.3')],
    c8: [user('u8', 'how much ibuprofen can i take in a day'), answer('a8', 'deepseek-flash', { error: 'deepseek-flash returned no output' }, ''),
      { id: 'x8', role: 'assistant', content: '**Update to an earlier answer**', metadata: { kind: 'check_addendum' }, createdAt: new Date('2026-10-04T10:05:00Z') }],
  };
  const prisma: any = {
    user: { findUnique: jest.fn(async ({ where }: any) => (where.email === 'claudebot@digby.ai' ? { id: 'u-bot' } : null)) },
    crossModelChat: { findMany: jest.fn(async ({ where }: any) => chats.filter((c) => where.userId === 'u-bot' && c.title.startsWith(where.title.startsWith))) },
    crossModelMessage: { findMany: jest.fn(async ({ where }: any) => messages[where.chatId] ?? []) },
  };
  const stored: Record<string, any> = {
    'instance:model-bench/scorecard': {
      updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['r0'],
      models: { 'kimi-k3': { lanes: { all: { n: 4, ttftP50Ms: 9000, ttftP90Ms: 12000, doneP50Ms: 30000, failRate: 0, quality: 4.25, qualityN: 4, runId: 'r0', at: '2026-10-01T00:00:00.000Z' } } } },
    },
  };
  const store = {
    storeGet: jest.fn(async (ns: string[], key: string) => stored[`${ns.join(':')}/${key}`] ?? null),
    storePut: jest.fn(async (ns: string[], key: string, value: any) => { stored[`${ns.join(':')}/${key}`] = value; }),
  };
  const judge = jest.fn(async (_q: string, a: string) => ({ score: /great/.test(a) ? 5 : 3, issue: 'none' }));
  const deleteChat = jest.fn(async () => undefined);
  const lines: string[] = [];
  const deps = { leaf, prisma, store, judge, judgeModel: async () => 'deepseek-flash', deleteChat, sleep: async () => {} };
  return { deps, store, stored, judge, deleteChat, prisma, lines, log: (l: string) => lines.push(l) };
}

describe('model-bench-ingest run()', () => {
  it('dry run: selects the run by title, judges only measured answers, aggregates with the leaf, writes nothing', async () => {
    const f = fixtures();
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: f.deps, log: f.log });
    expect(out.exitCode).toBe(0);
    const r = out.result;
    expect(r).toMatchObject({ runId: 'mb1', chats: 7, rows: 5, skipped: { otherTitle: 1, unsent: 1 }, judged: 2, judgeFailed: 0, judgeModel: 'deepseek-flash', applied: false, deleted: 0 });
    expect(r.attribution).toEqual({ 'glm-5.3': { measured: 1, diverted: 1 }, 'deepseek-flash': { measured: 1, failover: 1, failed: 1 } });
    // the judge saw the real question + answer of the measured rows only
    expect(f.judge.mock.calls.map((c) => c[1]).sort()).toEqual(['A great answer about rivers and salt.', 'Rivers carry salts.']);
    expect(f.judge.mock.calls.every((c) => c[0] === 'why is the ocean salty')).toBe(true);
    const g = r.scorecard.models['glm-5.3'].lanes;
    expect(g.all).toMatchObject({ n: 1, ttftP50Ms: 4000, doneP50Ms: 12000, failRate: 0, quality: 5, qualityN: 1, runId: 'mb1' });
    expect(g.quick).toBeUndefined(); // the Quick-lane diversion never feeds glm-5.3
    const d = r.scorecard.models['deepseek-flash'].lanes;
    expect(d.all).toMatchObject({ n: 3, ttftP50Ms: 2000, failRate: 0.6667, quality: 3, qualityN: 1 });
    expect(d.checked).toMatchObject({ n: 1, failRate: 1, ttftP50Ms: null });
    expect(f.store.storePut).not.toHaveBeenCalled();
    expect(f.deleteChat).not.toHaveBeenCalled();
    expect(f.lines.some((l) => /deepseek-flash shares the judge's family \(deepseek\)/.test(l))).toBe(true);
    expect(f.lines.some((l) => /dry run — nothing written/.test(l))).toBe(true);
    // aggregates only: no question / answer text in the result or the log
    const blob = JSON.stringify(r) + f.lines.join('\n');
    expect(blob).not.toMatch(/ocean|rivers|ibuprofen|Toronto/i);
  });

  it('--apply MERGES into [instance, model-bench] / scorecard (other models kept, runs unioned)', async () => {
    const f = fixtures();
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], deps: f.deps, log: f.log });
    expect(out.result.applied).toBe(true);
    expect(f.store.storePut).toHaveBeenCalledTimes(1);
    const [ns, key, value] = f.store.storePut.mock.calls[0] as any[];
    expect(ns).toEqual(['instance', 'model-bench']);
    expect(key).toBe('scorecard');
    expect(Object.keys(value.models).sort()).toEqual(['deepseek-flash', 'glm-5.3', 'kimi-k3']);
    expect(value.runs).toEqual(['r0', 'mb1']);
    expect(value.updatedBy).toBe('model-bench-ingest');
    expect(value.models['kimi-k3'].lanes.all.runId).toBe('r0');
    expect(f.deleteChat).not.toHaveBeenCalled();
  });

  it('--cleanup needs --apply; with it, every chat of the run (preflight + never-sent included) is deleted, no other run', async () => {
    const f = fixtures();
    expect(await script.run({ argv: ['--run-id', 'mb1', '--cleanup'], deps: f.deps, log: f.log })).toMatchObject({ exitCode: 2, error: expect.stringMatching(/--apply/) });
    expect(f.store.storePut).not.toHaveBeenCalled();
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply', '--cleanup'], deps: f.deps, log: f.log });
    expect(out.result.deleted).toBe(7);
    expect(f.deleteChat.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c8']);
    expect(f.deleteChat.mock.calls.every((c: any[]) => c[1] === 'u-bot')).toBe(true);
  });

  it('a store READ failure writes nothing (never merged as "no row")', async () => {
    const f = fixtures();
    f.store.storeGet.mockRejectedValueOnce(new Error('db down'));
    await expect(script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], deps: f.deps, log: f.log })).rejects.toThrow('db down');
    expect(f.store.storePut).not.toHaveBeenCalled();
  });

  it('--no-judge skips the judge; a build without the exported judge refuses unless --no-judge; env twins work', async () => {
    const f = fixtures();
    const out = await script.run({ argv: ['--run-id', 'mb1', '--no-judge'], deps: f.deps, log: f.log });
    expect(f.judge).not.toHaveBeenCalled();
    expect(out.result.scorecard.models['glm-5.3'].lanes.all).toMatchObject({ quality: null, qualityN: 0 });
    const { judge: _drop, ...noJudge } = f.deps;
    expect(await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: noJudge, log: f.log })).toMatchObject({ exitCode: 3 });
    const viaEnv = await script.run({ argv: [], env: { RUN_ID: 'mb1', APPLY: '1', NO_JUDGE: '1' }, deps: f.deps, log: f.log });
    expect(viaEnv.result).toMatchObject({ runId: 'mb1', applied: true, judged: 0 });
  });

  it('a failed judge call leaves that row unscored; usage errors exit 2', async () => {
    const f = fixtures();
    f.judge.mockRejectedValueOnce(new Error('seat down'));
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1', '--judge-concurrency', '1'], deps: f.deps, log: f.log });
    expect(out.result.judged + out.result.judgeFailed).toBe(2);
    expect(out.result.judgeFailed).toBe(1);
    expect(await script.run({ argv: [], deps: f.deps, log: f.log })).toMatchObject({ exitCode: 2 });
    expect(await script.run({ argv: ['--run-id', 'a b'], deps: f.deps, log: f.log })).toMatchObject({ exitCode: 2 });
  });

  it('pure helpers (P1.3): grouping key, seeded-shuffle determinism, family guard, rank mapping, rank→quality', () => {
    const rows = [
      { questionIdx: 1, spec: 'glm-5.3', chatId: 'c1' },
      { questionIdx: 1, spec: 'deepseek-flash', chatId: 'c2' },
      { questionIdx: 2, spec: 'kimi-k3', chatId: 'c4' },
    ];
    expect(script.groupByQuestion(rows).map((g: any) => [g.questionIdx, g.rows.length])).toEqual([[1, 2], [2, 1]]);
    expect(script.groupByQuestion([{ chatId: 'cX' }, {}]).map((g: any) => g.rows.length)).toEqual([1, 1]); // no questionIdx → per-chat fallback, never merged
    const g = { questionIdx: 1, rows: rows.slice(0, 2) };
    const a1 = script.anonymizeGroup(g, 'mb1');
    const a2 = script.anonymizeGroup({ questionIdx: 1, rows: rows.slice(0, 2) }, 'mb1');
    expect(a1.pairs.map((p: any) => p.label).sort()).toEqual(['A', 'B']);
    expect(a1.pairs.map((p: any) => p.row.spec).sort()).toEqual(['deepseek-flash', 'glm-5.3']); // every row exactly once
    expect(a2.pairs.map((p: any) => p.row.chatId)).toEqual(a1.pairs.map((p: any) => p.row.chatId)); // same runId+questionIdx → same shuffle
    expect(script.judgeFamilyConflicts('deepseek-flash', g)).toBe(true);
    expect(script.judgeFamilyConflicts('kimi-k3', g)).toBe(false);
    expect(script.judgeFamilyConflicts(null, g)).toBe(false);
    const l2r = new Map([['A', { spec: 'glm-5.3' }], ['B', { spec: 'deepseek-flash' }]]);
    expect(script.mapRankingToModels(['B', 'A'], l2r)).toEqual([{ spec: 'deepseek-flash', rank: 1, label: 'B' }, { spec: 'glm-5.3', rank: 2, label: 'A' }]);
    expect(script.mapRankingToModels({ ranking: ['B', 'A'] }, l2r)).toEqual(script.mapRankingToModels(['B', 'A'], l2r));
    expect(script.mapRankingToModels({ order: ['A'] }, l2r)).toEqual([{ spec: 'glm-5.3', rank: 1, label: 'A' }, { spec: 'deepseek-flash', rank: 2, label: 'B' }]); // label missing from the ranking appended, keeps its slot
    expect(script.mapRankingToModels(null, l2r)).toBeNull();
    expect(script.mapRankingToModels(['A', 'A', 'X'], l2r)).toEqual([{ spec: 'glm-5.3', rank: 1, label: 'A' }, { spec: 'deepseek-flash', rank: 2, label: 'B' }]); // dup + unknown labels skipped
    expect([1, 2, 3, 4].map((k) => [1, 2, 3, 4].map((r) => script.rankToQuality(r, k)))).toEqual([
      [5, 5, 5, 5], [5, 1, 1, 1], [5, 3, 1, 1], [5, 4, 2, 1],
    ]);
    expect(script.rankToQuality(9, 3)).toBe(1); // rank clamped to K
  });

  it('run() blind comparative judging (P1.3): one judgeComparative call per multi-measured group; family guard and judge failure fall back absolute', async () => {
    const f = fixtures();
    // the comparative judge ranks by answer text (descending) — model-independent, so the assertion is shuffle-proof
    const judgeComparative = jest.fn(async (_q: string, answers: any[]) =>
      [...answers].sort((x: any, y: any) => String(y.answer).localeCompare(String(x.answer))).map((a: any) => a.label));
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...f.deps, judgeModel: async () => 'gpt-oss-120b', judgeComparative }, log: f.log });
    expect(out.result).toMatchObject({ judged: 2, judgedComparative: 2, judgedAbsolute: 0, comparativeGroups: 1, familyGuardGroups: 0, comparativeFailedGroups: 0, judgeFailed: 0, judgeModel: 'gpt-oss-120b' });
    expect(f.judge).not.toHaveBeenCalled(); // no absolute call on the comparative path
    expect(judgeComparative).toHaveBeenCalledTimes(1);
    const [q, answers] = judgeComparative.mock.calls[0] as any[];
    expect(q).toBe('why is the ocean salty');
    expect(answers.map((a: any) => a.label).sort()).toEqual(['A', 'B']);
    expect(answers.map((a: any) => a.answer).sort()).toEqual(['A great answer about rivers and salt.', 'Rivers carry salts.']);
    expect(answers.every((a: any) => Object.keys(a).sort().join(',') === 'answer,label')).toBe(true); // blind: the judge never sees a model identity
    // 'Rivers carry salts.' sorts after 'A great…' → deepseek-flash rank 1 → quality 5; glm-5.3 rank 2 (K=2) → quality 1
    expect(out.result.scorecard.models['deepseek-flash'].lanes.all).toMatchObject({ quality: 5, qualityN: 1 });
    expect(out.result.scorecard.models['glm-5.3'].lanes.all).toMatchObject({ quality: 1, qualityN: 1 });
    expect(f.lines.some((l) => l.includes('COMPARATIVE_RUBRIC'))).toBe(true);
    expect(f.lines.some((l) => /1 comparative group\(s\) \(2 row\(s\)\), 0 absolute row\(s\)/.test(l))).toBe(true);
    expect(f.store.storePut).not.toHaveBeenCalled(); // dry run still writes nothing

    // family guard: the deepseek judge shares a family with a candidate of the group → absolute fallback, disclosed in the log
    const fg = fixtures();
    const out2 = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...fg.deps, judgeComparative: jest.fn(async () => ['A', 'B']) }, log: fg.log });
    expect(out2.result).toMatchObject({ judged: 2, judgedComparative: 0, judgedAbsolute: 2, comparativeGroups: 0, familyGuardGroups: 1, judgeFailed: 0, judgeModel: 'deepseek-flash' });
    expect(fg.judge).toHaveBeenCalledTimes(2);
    expect(fg.lines.some((l) => l.includes('family-guard group(s) fell back absolute'))).toBe(true);

    // a failed/unusable comparative call (defaultComparativeJudge → null) → per-answer absolute fallback
    const ff = fixtures();
    const out3 = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...ff.deps, judgeModel: async () => 'gpt-oss-120b', judgeComparative: jest.fn(async () => null) }, log: ff.log });
    expect(out3.result).toMatchObject({ judged: 2, judgedComparative: 0, judgedAbsolute: 2, comparativeFailedGroups: 1, judgeFailed: 1 });
    expect(ff.judge).toHaveBeenCalledTimes(2);
  });

  // roster 2026-10-06 C-2: the answer's parts are read so each bench bucket carries its web tool use.
  it('reads the answer parts: per-lane webToolsMean in the scorecard and the summary line', async () => {
    const f = fixtures();
    const parts = [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine' }, { type: 'tool_call', name: 'scrape_as_markdown' }];
    const orig = f.prisma.crossModelMessage.findMany.getMockImplementation();
    f.prisma.crossModelMessage.findMany.mockImplementation(async (q: any) => {
      const rows = await orig(q);
      return q.where.chatId === 'c1' ? rows.map((m: any) => (m.role === 'assistant' ? { ...m, parts } : m)) : rows;
    });
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: f.deps, log: f.log });
    expect(f.prisma.crossModelMessage.findMany.mock.calls.every((c: any[]) => c[0].select.parts === true)).toBe(true);
    expect(out.result.scorecard.models['glm-5.3'].lanes.all.webToolsMean).toBe(2);
    expect('webToolsMean' in out.result.scorecard.models['deepseek-flash'].lanes.all).toBe(false); // its rows carried no parts
    expect(f.lines.some((l) => /^ {2}all .* · web tools 2$/.test(l))).toBe(true);
    expect(f.lines.some((l) => / · web tools -$/.test(l))).toBe(true);
  });

  it('run() P1.5 judge-family diversity: a conflicting Utility seat auto-picks a conflict-free comparative judge from the catalog; --judge-model pins one; the pinned judge failure falls back absolute', async () => {
    // AUTO-PICK: the Utility seat is deepseek-family and a MEASURED row is deepseek (the guard's own condition —
    // a diverted answer led by a qwen model does NOT make qwen a candidate) → judgeComparative (the seat path)
    // is NEVER called. Candidates here are glm + deepseek, so the qwen card is conflict-free and wins on tier
    // (open + standard beats the fast mimo; frontier claude sorts last) — the mb1006a shape (qwen candidates
    // exclude every qwen card) is covered by the pickConflictFreeJudge assertions below.
    const f = fixtures();
    const cards = [
      { spec: 'cql-litellm:api-anthropic-claude-fable-5-1', family: 'claude', tier: 'strong', servable: true, autoEligible: false },
      { spec: 'cql-litellm:mimo-v26-flash-rl', family: 'mimo', tier: 'fast', servable: true, autoEligible: true },
      { spec: 'glm-5.3', family: 'glm', tier: 'strong', servable: true, autoEligible: true },
      { spec: 'cql-litellm:api-alibaba-qwen3.8-open', family: 'qwen', tier: 'standard', servable: true, autoEligible: true },
      { spec: 'cql-litellm:agx-laya', family: 'decision', servable: true, autoEligible: true },
      { spec: 'cql-litellm:agx-chat', family: 'other', servable: true, autoEligible: true },
    ];
    const judgeComparative = jest.fn(async () => { throw new Error('the seat path must not run'); });
    const judgeComparativeOnModel = jest.fn(async (_q: string, answers: any[], _spec: string) =>
      [...answers].sort((x: any, y: any) => String(y.answer).localeCompare(String(x.answer))).map((a: any) => a.label));
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...f.deps, judgeModel: async () => 'deepseek-flash', judgeComparative, judgeComparativeOnModel, listCatalog: async () => cards }, log: f.log });
    expect(out.result).toMatchObject({ judged: 2, judgedComparative: 2, judgedAbsolute: 0, comparativeGroups: 1, familyGuardGroups: 0, judgeModel: 'deepseek-flash', judgeSpec: 'cql-litellm:api-alibaba-qwen3.8-open' });
    expect(judgeComparative).not.toHaveBeenCalled();
    expect(judgeComparativeOnModel).toHaveBeenCalledTimes(1);
    expect(judgeComparativeOnModel.mock.calls[0][2]).toBe('cql-litellm:api-alibaba-qwen3.8-open'); // the picked spec rides every call
    // 'Rivers carry salts.' sorts after 'A great…' → deepseek-flash rank 1 → quality 5; glm-5.3 rank 2 → quality 1
    expect(out.result.scorecard.models['deepseek-flash'].lanes.all).toMatchObject({ quality: 5, qualityN: 1 });
    expect(f.lines.some((l) => /auto-picked from the model catalog: cql-litellm:api-alibaba-qwen3\.8-open/.test(l))).toBe(true);
    expect(f.lines.some((l) => /on cql-litellm:api-alibaba-qwen3\.8-open/.test(l))).toBe(true);
    expect(f.judge).not.toHaveBeenCalled(); // no absolute call on the comparative path

    // --judge-model PINS: same catalog, but the flag's spec wins over the auto-pick (grok conflicts with nothing measured)
    const g = fixtures();
    const pinOnModel = jest.fn(async (_q: string, _answers: any[], _spec: string) => ['A', 'B']);
    const out2 = await script.run({ argv: [...V1, '--run-id', 'mb1', '--judge-model', 'cql-litellm:api-xai-grok-4.7'], deps: { ...g.deps, judgeModel: async () => 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', judgeComparativeOnModel: pinOnModel, listCatalog: async () => cards }, log: g.log });
    expect(out2.result).toMatchObject({ judgedComparative: 2, judgeSpec: 'cql-litellm:api-xai-grok-4.7' });
    expect(pinOnModel.mock.calls[0][2]).toBe('cql-litellm:api-xai-grok-4.7');
    expect(g.lines.some((l) => /PINNED to cql-litellm:api-xai-grok-4.7/.test(l))).toBe(true);

    // a CONFLICTING pinned spec still trips the family guard: comparative off, absolute fallback, disclosed
    const h = fixtures();
    const conflictOnModel = jest.fn(async (_q: string, _answers: any[], _spec: string) => ['A', 'B']);
    const out3 = await script.run({ argv: [...V1, '--run-id', 'mb1', '--judge-model', 'cql-litellm:api-deepseek-v4-pro'], deps: { ...h.deps, judgeModel: async () => 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', judgeComparativeOnModel: conflictOnModel, listCatalog: async () => cards }, log: h.log });
    expect(out3.result).toMatchObject({ judgedComparative: 0, judgedAbsolute: 2, familyGuardGroups: 1, judgeSpec: 'cql-litellm:api-deepseek-v4-pro' });
    expect(conflictOnModel).not.toHaveBeenCalled();
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.lines.some((l) => /family-guard group\(s\) fell back absolute/.test(l))).toBe(true);

    // a pinned judge that FAILS (comparativeJudgeOnModel → null) → per-answer absolute fallback
    const i = fixtures();
    const out4 = await script.run({ argv: [...V1, '--run-id', 'mb1', '--judge-model', 'cql-litellm:api-xai-grok-4.7'], deps: { ...i.deps, judgeModel: async () => 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', judgeComparativeOnModel: jest.fn(async () => null), listCatalog: async () => cards }, log: i.log });
    expect(out4.result).toMatchObject({ judgedComparative: 0, judgedAbsolute: 2, comparativeFailedGroups: 1, judgeFailed: 1 });
    expect(i.judge).toHaveBeenCalledTimes(2);

    // no conflict and no --judge-model → the seat path (judgeComparative) runs as before, untouched
    const j = fixtures();
    const seatPath = jest.fn(async () => ['B', 'A']);
    const out5 = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...j.deps, judgeModel: async () => 'gpt-oss-120b', judgeComparative: seatPath, judgeComparativeOnModel: jest.fn(async () => null), listCatalog: async () => cards }, log: j.log });
    expect(out5.result).toMatchObject({ judgedComparative: 2, judgedAbsolute: 0, judgeSpec: null });
    expect(seatPath).toHaveBeenCalledTimes(1);

    // a conflicting seat with NO conflict-free catalog model → every group falls back absolute, disclosed
    const k = fixtures();
    const out6 = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...k.deps, judgeModel: async () => 'deepseek-flash', judgeComparative: jest.fn(async () => ['A', 'B']), judgeComparativeOnModel: jest.fn(async () => ['A', 'B']), listCatalog: async () => [{ spec: 'glm-5.3', family: 'glm', tier: 'strong', servable: true, autoEligible: true }] }, log: k.log });
    expect(out6.result).toMatchObject({ judgedComparative: 0, judgedAbsolute: 2, familyGuardGroups: 1, judgeSpec: null });
    expect(k.lines.some((l) => /no conflict-free catalog model was found/.test(l))).toBe(true);
  });

  it('pure helpers: args, families, the bias warning, the conflict-free judge pick', () => {
    // roster 2026-10-06 C-2: frontier candidates (owner: "any and all models") get the judge-family guard too.
    expect(script.familyOf('cql-litellm:gpt-5.6-sol')).toBe('gpt');
    expect(script.familyOf('cql-litellm:gpt-oss-120b')).toBe('gpt-oss');
    expect(script.familyOf('cql-litellm:grok-4.5')).toBe('grok');
    expect(script.familyOf('cql-litellm:gemini-3.5-flash')).toBe('gemini');
    expect(script.parseArgs(['--run-id', 'mb1', '--judge-concurrency', '99'], {})).toMatchObject({ runId: 'mb1', apply: false, cleanup: false, judge: true, judgeConcurrency: 8, error: '' });
    expect(script.parseArgs(['--run-id', 'mb1', '--judge-model', 'cql-litellm:mimo-v26-flash-rl'], {})).toMatchObject({ judgeModel: 'cql-litellm:mimo-v26-flash-rl', error: '' });
    expect(script.parseArgs([], { RUN_ID: 'mb1', JUDGE_MODEL: 'glm-5.3' })).toMatchObject({ judgeModel: 'glm-5.3' });
    expect(script.parseArgs(['--run-id', 'mb1'], { JUDGE_MODEL: '  ' })).toMatchObject({ judgeModel: null });
    expect(script.familyOf('cql-litellm:api-optimize-alibaba-qwen3.8-flash')).toBe('qwen');
    expect(script.familyOf('cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash')).toBe('deepseek');
    expect(script.familyOf('glm-5.3')).toBe('glm');
    // the catalog's family vocabulary (P1.5: the ingest's guard must agree with model-catalog.ts)
    expect(script.familyOf('cql-litellm:mimo-v26-flash-rl')).toBe('mimo');
    expect(script.familyOf('cql-litellm:api-anthropic-claude-fable-5-1')).toBe('claude');
    expect(script.familyOf('cql-litellm:api-xai-grok-4.7')).toBe('grok');
    expect(script.familyOf('cql-litellm:api-cohere-command-a-plus')).toBe('cohere');
    expect(script.familyOf('cql-litellm:agx-laya')).toBe('decision');
    expect(script.familyOf('cql-litellm:agx-chat')).toBe('other');
    expect(script.judgeBiasWarnings('glm-5.3-flash', ['glm-5.3', 'kimi-k3'])).toEqual([expect.stringMatching(/^glm-5.3 shares the judge's family \(glm\)/)]);
    expect(script.judgeBiasWarnings(null, ['glm-5.3'])).toEqual([]);
    // pickConflictFreeJudge: open/non-frontier preferred, then strongest tier, never other/decision families
    const cards = [
      { spec: 'cql-litellm:api-anthropic-claude-fable-5-1', family: 'claude', tier: 'strong', servable: true, autoEligible: false },
      { spec: 'cql-litellm:mimo-v26-flash-rl', family: 'mimo', tier: 'fast', servable: true, autoEligible: true },
      { spec: 'cql-litellm:api-cohere-command-a-plus', family: 'cohere', tier: 'standard', servable: true, autoEligible: true },
      { spec: 'glm-5.3', family: 'glm', tier: 'strong', servable: true, autoEligible: true },
      { spec: 'cql-litellm:agx-laya', family: 'decision', servable: true, autoEligible: true },
      { spec: 'cql-litellm:agx-chat', family: 'other', servable: true, autoEligible: true },
    ];
    expect(script.pickConflictFreeJudge(cards, ['glm-5.3', 'deepseek-flash'])).toBe('cql-litellm:api-cohere-command-a-plus'); // open, standard beats the fast mimo
    expect(script.pickConflictFreeJudge(cards, ['glm-5.3', 'kimi-k3', 'deepseek-flash', 'qwen3.6-27b', 'cql-litellm:api-cohere-command-a-plus'])).toBe('cql-litellm:mimo-v26-flash-rl'); // cohere conflicts → mimo
    expect(script.pickConflictFreeJudge(cards, ['glm-5.3', 'kimi-k3', 'deepseek-flash', 'qwen3.6-27b', 'cql-litellm:mimo-v26-flash-rl', 'cql-litellm:api-cohere-command-a-plus', 'cql-litellm:api-anthropic-claude-fable-5-1'])).toBeNull(); // every named family conflicts; other/decision never picked
    expect(script.pickConflictFreeJudge(null, ['glm-5.3'])).toBeNull();
  });

  // 28d9e351 (replay): an UNATTENDED ingest (the CI systemd-run → prodq.sh docker-exec shape, stdin not a tty)
  // without --judge-model must never silently write absolute-scale rows onto the comparative scorecard. The
  // incident shape: the family-conflict auto-pick chose a route the gateway had retired but the endpoint
  // registry still listed (api-cohere-command-a-plus, every call 400) → comparativeJudgeOnModel → null → silent
  // per-answer absolute fallback → 95 contaminated rows landed on ['instance','model-bench'] / 'scorecard'.
  it('28d9e351 unattended fail-safe: no --judge-model + a retired/unservable auto-pick route ⇒ default judge pins comparative; any absolute fallback REFUSES (exit 1, nothing written)', async () => {
    // unattendedContext: the real spawner shapes — docker exec (stdin not a tty), systemd (INVOCATION_ID /
    // MANAGED_BY), explicit --unattended; --attended / UNATTENDED=0 force the attended path back on.
    expect(script.unattendedContext({ argv: [], env: {}, isTTY: false })).toBe(true); // the prodq.sh shape
    expect(script.unattendedContext({ argv: [], env: { INVOCATION_ID: 'abc.0' }, isTTY: true })).toBe(true); // the systemd-run shape
    expect(script.unattendedContext({ argv: [], env: { MANAGED_BY: 'systemd' }, isTTY: true })).toBe(true);
    expect(script.unattendedContext({ argv: ['--unattended'], env: {}, isTTY: true })).toBe(true);
    expect(script.unattendedContext({ argv: [], env: {}, isTTY: true })).toBe(false); // a watched terminal run
    expect(script.unattendedContext({ argv: ['--attended'], env: {}, isTTY: false })).toBe(false); // explicit override
    expect(script.unattendedContext({ argv: [], env: { UNATTENDED: '0' }, isTTY: false })).toBe(false);
    expect(script.unattendedContext({ argv: [], env: { UNATTENDED: '1' }, isTTY: true })).toBe(true);
    // run() consults deps.isTTY (main() passes the real process.stdin.isTTY) — omitted ⇒ attended by default,
    // so the EXISTING offline-test path (no isTTY in deps) never trips the guard.
    expect(script.DEFAULT_UNATTENDED_JUDGE).toBe('qwen3.6-27b');

    // pickConflictFreeJudge hard-skips retired routes AT THE SCRIPT LEVEL (belt under the registry flag — a
    // listed-but-retired card must never win even when it sorts first among the conflict-free). The INCIDENT
    // card pre-#1315 was still servable:true in the registry (the 400 only surfaced at call time — that shape
    // is the refuse in REPLAY B); here it carries the retirement in both field spellings.
    const cards = [
      { spec: 'cql-litellm:api-cohere-command-a-plus', family: 'cohere', tier: 'standard', servable: false, autoEligible: true }, // retired flag rendered the card unservable
      { spec: 'cql-litellm:api-cohere-command-a-plus', family: 'cohere', tier: 'standard', servable: false, unservable: true, autoEligible: true }, // either field spelling
      { spec: 'cql-litellm:mimo-v26-flash-rl', family: 'mimo', tier: 'fast', servable: true, autoEligible: true },
    ];
    expect(script.pickConflictFreeJudge(cards, ['glm-5.3', 'deepseek-flash'])).toBe('cql-litellm:mimo-v26-flash-rl'); // the retired cohere card sorts first on tier — and is skipped
    expect(script.pickConflictFreeJudge([cards[0]], ['glm-5.3'])).toBeNull(); // nothing but the retired card ⇒ null, never it

    // REPLAY A: the ticket's verification bar — unattended, NO --judge-model, the pinned route UNSERVABLE ⇒
    // the default judge pins anyway and judges COMPARATIVE; when even that fails, the run REFUSES (exit 1,
    // nothing written) — never silently writes absolute-scale rows.
    const ra = fixtures();
    const rankedByAnswer = async (_q: string, answers: any[]) =>
      [...answers].sort((x: any, y: any) => String(y.answer).localeCompare(String(x.answer))).map((a: any) => a.label);
    const onModel = jest.fn(rankedByAnswer as any);
    // candidates glm+deepseek, so the pinned default (qwen family) is conflict-free — the usual shape.
    const outA = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], env: {}, deps: { ...ra.deps, isTTY: false, judgeModel: async () => 'deepseek-flash', judgeComparativeOnModel: onModel, listCatalog: async () => [{ spec: 'qwen3.6-27b', family: 'qwen', tier: 'fast', servable: false, autoEligible: true }] }, log: ra.log });
    expect(outA.exitCode).toBe(0);
    expect(outA.result).toMatchObject({ judged: 2, judgedComparative: 2, judgedAbsolute: 0, judgeSpec: 'qwen3.6-27b', applied: true });
    expect(onModel).toHaveBeenCalledTimes(1);
    expect(onModel.mock.calls[0][2]).toBe('qwen3.6-27b'); // the default judge, not the unservable catalog card
    expect(ra.lines.some((l) => /pinning the comparative judge to the default qwen3\.6-27b/.test(l))).toBe(true);
    expect(ra.judge).not.toHaveBeenCalled(); // no absolute call on the comparative path

    // 2026-10-20: a TRANSIENT comparative failure is retried (--judge-attempts, default 3) before the absolute fallback —
    // one timeout no longer sinks a whole unattended 2-wave kind ingest. With --judge-attempts 1 the same failure still refuses.
    const rt = fixtures();
    let calls = 0;
    const flaky = jest.fn(async (q: string, answers: any[], spec: string) => (++calls === 1 ? null : rankedByAnswer(q, answers)));
    const outT = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply', '--judge-model', 'qwen3.6-27b'], env: {}, deps: { ...rt.deps, isTTY: false, judgeComparativeOnModel: flaky }, log: rt.log });
    expect(outT.exitCode).toBe(0);
    expect(outT.result).toMatchObject({ judgedComparative: 2, judgedAbsolute: 0, comparativeFailedGroups: 0, comparativeRetries: 1, applied: true });
    expect(flaky).toHaveBeenCalledTimes(2);
    const r1 = fixtures();
    let calls1 = 0;
    const flaky1 = jest.fn(async (q: string, answers: any[]) => (++calls1 === 1 ? null : rankedByAnswer(q, answers)));
    const outT1 = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply', '--judge-model', 'qwen3.6-27b', '--judge-attempts', '1'], env: {}, deps: { ...r1.deps, isTTY: false, judgeComparativeOnModel: flaky1 }, log: r1.log });
    expect(outT1.exitCode).toBe(1);
    expect(r1.store.storePut).not.toHaveBeenCalled();

    // REPLAY B (the incident itself): unattended, no --judge-model, the default judge route DEAD (every call
    // fails → null) ⇒ REFUSE — exit 1, the error says 28d9e351, storePut never called, deleteChat never called.
    const rb = fixtures();
    const outB = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], env: {}, deps: { ...rb.deps, isTTY: false, judgeModel: async () => 'deepseek-flash', judgeComparativeOnModel: jest.fn(async () => null), listCatalog: async () => [{ spec: 'cql-litellm:api-cohere-command-a-plus', family: 'cohere', tier: 'standard', servable: false, autoEligible: true }] }, log: rb.log });
    expect(outB).toMatchObject({ exitCode: 1 });
    expect(String(outB.error)).toMatch(/28d9e351/);
    expect(String(outB.error)).toMatch(/absolute-scale row/);
    expect(rb.store.storePut).not.toHaveBeenCalled(); // nothing written — the scorecard is never contaminated
    expect(rb.deleteChat).not.toHaveBeenCalled();

    // REPLAY C: --no-judge (judgeless) unattended writes NO quality and never refuses — the judgeless escape.
    const rc = fixtures();
    const outC = await script.run({ argv: ['--run-id', 'mb1', '--apply', '--no-judge'], env: {}, deps: { ...rc.deps, isTTY: false }, log: rc.log });
    expect(outC.exitCode).toBe(0);
    expect(outC.result).toMatchObject({ applied: true, judged: 0 });
    expect(outC.result.scorecard.models['glm-5.3'].lanes.all.quality).toBeNull();

    // REPLAY D: an attended run (tty) keeps the auto-pick + disclosed fallback exactly as before (28d9e351
    // changes only the unattended shape); a pinned --judge-model wins over the unattended default.
    const rd = fixtures();
    const outD = await script.run({ argv: [...V1, '--run-id', 'mb1'], env: {}, deps: { ...rd.deps, isTTY: true, judgeModel: async () => 'deepseek-flash', judgeComparativeOnModel: jest.fn(async () => null), listCatalog: async () => [{ spec: 'cql-litellm:api-cohere-command-a-plus', family: 'cohere', tier: 'standard', servable: false, autoEligible: true }] }, log: rd.log });
    expect(outD.exitCode).toBe(0); // absolute fallback still allowed for a human reading the log
    expect(outD.result).toMatchObject({ judgedAbsolute: 2, judgeSpec: null });
    const re_ = fixtures();
    const outE = await script.run({ argv: [...V1, '--run-id', 'mb1', '--judge-model', 'cql-litellm:api-xai-grok-4.7'], env: {}, deps: { ...re_.deps, isTTY: false, judgeModel: async () => 'deepseek-flash', judgeComparativeOnModel: jest.fn(async () => ['A', 'B']) }, log: re_.log });
    expect(outE.result).toMatchObject({ judgeSpec: 'cql-litellm:api-xai-grok-4.7', judgedComparative: 2 }); // the flag beats the default pin

    // REPLAY F (reviewer F1+F3): a build WITHOUT comparativeJudgeOnModel (pre-P1.5) + an unattended run where
    // every absolute judge call FAILS — judgedAbsolute stays 0 and comparativeFailedGroups stays 0, so the first
    // cut of the guard let quality-less rows land with exit 0 (the same silent degradation as the incident);
    // judgeFailed > 0 alone now REFUSES, and the legacy ⚠ says so up front instead of contradicting the pin log.
    const rf = fixtures();
    const outF = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], env: {}, deps: { ...rf.deps, isTTY: false, judge: jest.fn(async () => null), judgeModel: async () => 'deepseek-flash' }, log: rf.log });
    expect(outF).toMatchObject({ exitCode: 1 });
    expect(String(outF.error)).toMatch(/28d9e351/);
    expect(outF.result).toBeUndefined(); // refused — nothing written, no result payload
    expect(rf.store.storePut).not.toHaveBeenCalled();
    expect(rf.deleteChat).not.toHaveBeenCalled();
    expect(rf.lines.some((l) => /ignored — this build does not export live-chat-audit\.comparativeJudgeOnModel/.test(l) && /UNATTENDED run will REFUSE/.test(l))).toBe(true);

    // REPLAY G — PIN CHANGED 2026-10-20 (singleton hardening). This replay first pinned (reviewer F1, modern build)
    // that a SINGLETON group (rows.length < 2) whose absolute judge call failed made the unattended run REFUSE.
    // Singletons are no longer absolute-scored at all: the lone answer stays UNJUDGED (quality null, counted in
    // `singletonsUnjudged`), so the SAME run now succeeds — the 2-row group still ranks comparative on the pinned
    // default, the absolute judge is never called and nothing absolute is written. (F1's "judgeFailed > 0 alone
    // refuses" rule is unchanged and still pinned by REPLAY F above.)
    const rgChats = [
      { id: 's1', title: 'model-bench mb1 q1 glm-5.3' },
      { id: 's2', title: 'model-bench mb1 q1 deepseek-flash' },
      { id: 's3', title: 'model-bench mb1 q9 kimi-k3' }, // the singleton
    ];
    const rgMsgs: Record<string, any[]> = {
      s1: [user('u1', 'why is the sky blue'), answer('a1', 'glm-5.3', {}, 'A long answer one.')],
      s2: [user('u2', 'why is the sky blue'), answer('a2', 'deepseek-flash', {}, 'A long answer two.')],
      s3: [user('u3', 'how tall is the eiffel tower'), answer('a3', 'kimi-k3', {}, 'A solo answer.')],
    };
    const rgPrisma: any = {
      user: { findUnique: jest.fn(async () => ({ id: 'u-bot' })) },
      crossModelChat: { findMany: jest.fn(async ({ where }: any) => rgChats.filter((c) => c.title.startsWith(where.title.startsWith))) },
      crossModelMessage: { findMany: jest.fn(async ({ where }: any) => rgMsgs[where.chatId] ?? []) },
    };
    const rgStore = { storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) };
    const rgLog: string[] = [];
    const rgJudge = jest.fn(async () => null);
    const outG = await script.run({ argv: [...V1, '--run-id', 'mb1', '--apply'], env: {}, deps: { leaf, prisma: rgPrisma, store: rgStore, isTTY: false, judge: rgJudge, judgeModel: async () => 'gpt-oss-120b', judgeComparativeOnModel: jest.fn(async (_q: string, answers: any[]) => answers.map((a: any) => a.label)) }, log: (l: string) => rgLog.push(l) });
    expect(outG.exitCode).toBe(0);
    expect(outG.result).toMatchObject({ judgedComparative: 2, judgedAbsolute: 0, comparativeFailedGroups: 0, judgeFailed: 0, singletonsUnjudged: 1, applied: true });
    expect(rgJudge).not.toHaveBeenCalled(); // the singleton is never absolute-scored
    expect(rgStore.storePut).toHaveBeenCalledTimes(1);
    expect(outG.result.scorecard.models['kimi-k3'].lanes.all).toMatchObject({ n: 1, failRate: 0, quality: null, qualityN: 0 }); // counted, unjudged
    expect(rgLog.some((l) => /^singletons unjudged: 1 — /.test(l))).toBe(true);
  });

  // 2026-10-20 singleton hardening, ATTENDED too: with a comparative judge available a lone answer is never put on the
  // absolute scale (one scale per scorecard); without any comparative judge every row is absolute, singletons included.
  it('a singleton question is left UNJUDGED whenever a comparative judge exists (attended or not); judgeless-comparative builds stay all-absolute', async () => {
    const f = fixtures();
    // add a lone kimi-k3 answer on q9 to the standard fixtures
    const chats0 = f.prisma.crossModelChat.findMany.getMockImplementation();
    f.prisma.crossModelChat.findMany.mockImplementation(async (q: any) => [...(await chats0(q)), { id: 'c10', title: 'model-bench mb1 q9 kimi-k3' }]);
    const msgs0 = f.prisma.crossModelMessage.findMany.getMockImplementation();
    f.prisma.crossModelMessage.findMany.mockImplementation(async (q: any) => (q.where.chatId === 'c10' ? [user('u10', 'how tall is the eiffel tower'), answer('a10', 'kimi-k3', {}, 'About 330 m.')] : msgs0(q)));
    const judgeComparative = jest.fn(async (_q: string, answers: any[]) => answers.map((a: any) => a.label));
    const out = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: { ...f.deps, judgeModel: async () => 'gpt-oss-120b', judgeComparative, isTTY: true }, log: f.log });
    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({ judgedComparative: 2, judgedAbsolute: 0, singletonsUnjudged: 1, judgeFailed: 0 });
    expect(f.judge).not.toHaveBeenCalled();
    expect(judgeComparative).toHaveBeenCalledTimes(1);
    expect(out.result.scorecard.models['kimi-k3'].lanes.all).toMatchObject({ n: 1, quality: null });
    // no comparative judge in this build at all → every row absolute (the singleton included) — one scale per run
    const g = fixtures();
    g.prisma.crossModelChat.findMany.mockImplementation(f.prisma.crossModelChat.findMany.getMockImplementation());
    g.prisma.crossModelMessage.findMany.mockImplementation(f.prisma.crossModelMessage.findMany.getMockImplementation());
    const out2 = await script.run({ argv: [...V1, '--run-id', 'mb1'], deps: g.deps, log: g.log });
    expect(out2.result).toMatchObject({ judgedAbsolute: 3, singletonsUnjudged: 0 });
    expect(g.judge).toHaveBeenCalledTimes(3);
  });

  // 2026-10-20 review, finding A: singleton hardening let an ALL-singleton run through (nothing absolute, nothing
  // failed) — on --apply its quality-null buckets wiped the judged ones. Unattended it now REFUSES; attended it writes
  // with a ⚠ and the leaf's merge keeps the stored judged quality; a MIXED run (≥ 1 comparative group) still writes.
  // Both judge versions: the all-singleton refusal / ⚠ / mixed-run rules are shared (judge v2, 2026-10-20).
  it.each(['v1', 'v2'])('an ALL-singleton run (%s; answers measured, 0 comparative groups) REFUSES unattended (exit 1, nothing written); attended writes with a ⚠ and keeps judged quality; a mixed run still writes', async (ver) => {
    expect(script.allSingletonRun({ measured: 2, comparativeGroups: 0, singletonsUnjudged: 2 })).toBe(true);
    expect(script.allSingletonRun({ measured: 3, comparativeGroups: 1, singletonsUnjudged: 1 })).toBe(false); // mixed
    expect(script.allSingletonRun({ measured: 0, comparativeGroups: 0, singletonsUnjudged: 0 })).toBe(false); // nothing measured
    expect(script.allSingletonRun({ measured: 2, comparativeGroups: 0, singletonsUnjudged: 0 })).toBe(false); // absolute path: the 28d9e351 refuse owns it
    expect(script.allSingletonRun()).toBe(false);
    // q1: only glm-5.3 measured (deepseek answered empty); q2: only deepseek-flash measured (glm failed over to kimi)
    const build = (withMixed = false) => {
      const chats = [
        { id: 's1', title: 'model-bench mbs q1 glm-5.3' },
        { id: 's2', title: 'model-bench mbs q1 deepseek-flash' },
        { id: 's3', title: 'model-bench mbs q2 glm-5.3' },
        { id: 's4', title: 'model-bench mbs q2 deepseek-flash' },
        ...(withMixed ? [{ id: 's5', title: 'model-bench mbs q3 glm-5.3' }, { id: 's6', title: 'model-bench mbs q3 deepseek-flash' }] : []),
      ];
      const msgs: Record<string, any[]> = {
        s1: [user('u1', 'why is the sky blue'), answer('a1', 'glm-5.3', { ttft: 6000 }, 'Rayleigh scattering.')],
        s2: [user('u2', 'why is the sky blue'), answer('a2', 'deepseek-flash', { error: 'deepseek-flash returned no output' }, '')],
        s3: [user('u3', 'how tall is the eiffel tower'), answer('a3', 'kimi-k3', {}, 'About 330 m.')],
        s4: [user('u4', 'how tall is the eiffel tower'), answer('a4', 'deepseek-flash', {}, 'Roughly 330 metres.')],
        s5: [user('u5', 'what is a haiku'), answer('a5', 'glm-5.3', {}, 'A great short poem form.')],
        s6: [user('u6', 'what is a haiku'), answer('a6', 'deepseek-flash', {}, 'Three lines.')],
      };
      const stored: Record<string, any> = {
        'instance:model-bench/scorecard': { updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['r0'],
          models: { 'glm-5.3': { lanes: { all: { n: 4, ttftP50Ms: 9000, ttftP90Ms: 12000, doneP50Ms: 30000, failRate: 0, quality: 4.25, qualityN: 4, runId: 'r0', at: '2026-10-01T00:00:00.000Z' } } } } },
      };
      const store = {
        storeGet: jest.fn(async (ns: string[], key: string) => stored[`${ns.join(':')}/${key}`] ?? null),
        storePut: jest.fn(async (ns: string[], key: string, value: any) => { stored[`${ns.join(':')}/${key}`] = value; }),
      };
      const prisma: any = {
        user: { findUnique: jest.fn(async () => ({ id: 'u-bot' })) },
        crossModelChat: { findMany: jest.fn(async ({ where }: any) => chats.filter((c) => c.title.startsWith(where.title.startsWith))) },
        crossModelMessage: { findMany: jest.fn(async ({ where }: any) => msgs[where.chatId] ?? []) },
      };
      const lines: string[] = [];
      const judge = jest.fn(async () => ({ score: 3, issue: 'none' }));
      const onModel = jest.fn(async (_q: string, answers: any[]) => [...answers].sort((x: any, y: any) => Number(/great/.test(y.answer)) - Number(/great/.test(x.answer))).map((a: any) => a.label));
      const deleteChat = jest.fn(async () => undefined);
      // both comparative paths (attended runs judge on the seat, unattended pin the default judge spec)
      const deps = { leaf, prisma, store, judge, judgeModel: async () => 'gpt-oss-120b', judgeComparative: onModel, judgeComparativeOnModel: onModel, deleteChat };
      return { deps, store, stored, judge, onModel, deleteChat, lines, log: (l: string) => lines.push(l) };
    };

    // UNATTENDED (the prodq.sh / CI shape): refuse — exit 1, no merge, no cleanup, nothing judged absolute
    const u = build();
    const outU = await script.run({ argv: ['--judge-version', ver, '--run-id', 'mbs', '--apply', '--cleanup'], env: {}, deps: { ...u.deps, isTTY: false }, log: u.log });
    expect(outU).toMatchObject({ exitCode: 1 });
    expect(outU.result).toBeUndefined();
    expect(String(outU.error)).toMatch(/all-singleton run is a BROKEN run/);
    expect(String(outU.error)).toMatch(/2 answer\(s\).*0 comparative groups, 2 singleton\(s\) unjudged/);
    expect(u.store.storePut).not.toHaveBeenCalled();
    expect(u.deleteChat).not.toHaveBeenCalled();
    expect(u.judge).not.toHaveBeenCalled();
    expect(u.onModel).not.toHaveBeenCalled();

    // ATTENDED: writes, says so, and the merge keeps glm-5.3's stored judged quality (the leaf's finding-A rule)
    const a = build();
    const outA = await script.run({ argv: ['--judge-version', ver, '--run-id', 'mbs', '--apply'], env: {}, deps: { ...a.deps, isTTY: true }, log: a.log });
    expect(outA.exitCode).toBe(0);
    expect(outA.result).toMatchObject({ comparativeGroups: 0, singletonsUnjudged: 2, judgedAbsolute: 0, applied: true });
    expect(a.lines.some((l) => /⚠ all-singleton run: 2 measured answer\(s\), 0 comparative groups/.test(l))).toBe(true);
    const [, , value] = a.store.storePut.mock.calls[0] as any[];
    expect(value.models['glm-5.3'].lanes.all).toMatchObject({ quality: 4.25, qualityN: 4, n: 2, failRate: 0.5, ttftP50Ms: 6000, runId: 'mbs' });

    // the judgeless escape the refusal names: --no-judge unattended writes (no quality anywhere, judged quality kept)
    const nj = build();
    const outNJ = await script.run({ argv: ['--run-id', 'mbs', '--apply', '--no-judge'], env: {}, deps: { ...nj.deps, isTTY: false }, log: nj.log });
    expect(outNJ.exitCode).toBe(0);
    expect((nj.store.storePut.mock.calls[0] as any[])[2].models['glm-5.3'].lanes.all).toMatchObject({ quality: 4.25, qualityN: 4, runId: 'mbs' });

    // a MIXED run (q3 ranked by both models beside the two singletons) is a normal run — unattended still writes
    const m = build(true);
    const outM = await script.run({ argv: ['--judge-version', ver, '--run-id', 'mbs', '--apply'], env: {}, deps: { ...m.deps, isTTY: false }, log: m.log });
    expect(outM.exitCode).toBe(0);
    expect(outM.result).toMatchObject({ comparativeGroups: 1, judgedComparative: 2, singletonsUnjudged: 2, judgedAbsolute: 0, applied: true });
    expect(m.store.storePut).toHaveBeenCalledTimes(1);
    expect(m.lines.some((l) => /all-singleton/.test(l))).toBe(false);
    expect((m.store.storePut.mock.calls[0] as any[])[2].models['glm-5.3'].lanes.all).toMatchObject({ quality: 5, qualityN: 1, runId: 'mbs' }); // q3: glm's answer ranked first
  });

  // 2026-10-20 task kinds: `k:<kind>` titles + the answer's classified kind → models[spec].kinds in the merged row.
  it('task kinds: k:<kind> titles bucket per kind (title kind, else the classified kind), the agreement line, kinds merged into the store row', async () => {
    const kChats = [
      { id: 'k1', title: 'model-bench mbk q1 glm-5.3 k:code' },
      { id: 'k2', title: 'model-bench mbk q1 deepseek-flash k:code' },
      { id: 'k3', title: 'model-bench mbk q2 glm-5.3 k:writing' },
      { id: 'k4', title: 'model-bench mbk q2 deepseek-flash k:writing' },
      { id: 'k5', title: 'model-bench mbk q3 glm-5.3' }, // no title kind → the classified kind (planning)
      { id: 'k6', title: 'model-bench mbk q3 deepseek-flash' },
      { id: 'k7', title: 'model-bench mbk q4 glm-5.3 k:research' }, // an unknown kind token: parsed, counted by lane, no kind bucket
      { id: 'k8', title: 'model-bench mbk q4 deepseek-flash k:research' },
    ];
    const stamped = (id: string, modelUsed: string, kind: string | null, content: string) => {
      const a: any = answer(id, modelUsed, {}, content);
      a.metadata.depth.turnPlan = { lane: 'standard', ...(kind ? { taskKind: { kind, top: kind, p: 0.9, usable: true } } : {}) };
      return a;
    };
    const kMsgs: Record<string, any[]> = {
      k1: [user('v1', 'reverse a linked list in python'), stamped('b1', 'glm-5.3', 'code', 'A great iterative solution.')],
      k2: [user('v2', 'reverse a linked list in python'), stamped('b2', 'deepseek-flash', 'explain', 'Some code.')],
      k3: [user('v3', 'a toast for my sister'), stamped('b3', 'glm-5.3', 'writing', 'A great toast.')],
      k4: [user('v4', 'a toast for my sister'), stamped('b4', 'deepseek-flash', null, 'Cheers.')],
      k5: [user('v5', 'plan my week'), stamped('b5', 'glm-5.3', 'planning', 'A great plan.')],
      k6: [user('v6', 'plan my week'), stamped('b6', 'deepseek-flash', 'planning', 'Monday...')],
      k7: [user('v7', 'deep dive'), stamped('b7', 'glm-5.3', null, 'Deep.')],
      k8: [user('v8', 'deep dive'), stamped('b8', 'deepseek-flash', null, 'Deeper.')],
    };
    const stored: Record<string, any> = {
      'instance:model-bench/scorecard': { updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'model-bench-ingest', runs: ['r0'],
        models: { 'glm-5.3': { lanes: { all: { n: 4, ttftP50Ms: 9000, ttftP90Ms: 12000, doneP50Ms: 30000, failRate: 0, quality: 4.25, qualityN: 4, runId: 'r0', at: '2026-10-01T00:00:00.000Z' } },
          kinds: { explain: { n: 9, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 3.5, qualityN: 9, runId: 'r0', at: '2026-10-01T00:00:00.000Z', fieldSize: 3 } } } } },
    };
    const store = {
      storeGet: jest.fn(async (ns: string[], key: string) => stored[`${ns.join(':')}/${key}`] ?? null),
      storePut: jest.fn(async (ns: string[], key: string, value: any) => { stored[`${ns.join(':')}/${key}`] = value; }),
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ id: 'u-bot' })) },
      crossModelChat: { findMany: jest.fn(async ({ where }: any) => kChats.filter((c) => c.title.startsWith(where.title.startsWith))) },
      crossModelMessage: { findMany: jest.fn(async ({ where }: any) => kMsgs[where.chatId] ?? []) },
    };
    const lines: string[] = [];
    // the comparative judge ranks the answer containing "great" first — model-independent, shuffle-proof
    const judgeComparative = jest.fn(async (_q: string, answers: any[]) => [...answers].sort((x: any, y: any) => Number(/great/.test(y.answer)) - Number(/great/.test(x.answer))).map((a: any) => a.label));
    const out = await script.run({ argv: [...V1, '--run-id', 'mbk', '--apply'], deps: { leaf, prisma, store, judge: jest.fn(), judgeModel: async () => 'gpt-oss-120b', judgeComparative }, log: (l: string) => lines.push(l) });
    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({ rows: 8, skipped: { otherTitle: 0, unsent: 0 }, judgedComparative: 8, comparativeGroups: 4 });
    expect(out.result.kindAgreement).toEqual({ agree: 2, differ: 1, unstamped: 1, noTitleKind: 4 }); // the unknown-kind titles carry no title kind
    const g = out.result.scorecard.models['glm-5.3'];
    expect(Object.keys(g.kinds)).toEqual(['code', 'planning', 'writing']); // no 'research' bucket (unknown kind), q4 counted by lane only
    expect(g.kinds.code).toMatchObject({ n: 1, quality: 5, qualityN: 1, fieldSize: 2, runId: 'mbk' });
    expect(g.kinds.planning).toMatchObject({ n: 1, quality: 5, fieldSize: 2 }); // filed under the classified kind
    expect(g.lanes.all).toMatchObject({ n: 4, qualityN: 4 });
    expect(out.result.scorecard.models['deepseek-flash'].kinds.writing).toMatchObject({ quality: 1, fieldSize: 2 });
    expect(lines.some((l) => /^ {2}k:code {6}n {3}1 · .* · quality 5 \(1\) · field 2$/.test(l))).toBe(true);
    expect(lines.some((l) => l === 'kind agreement (the title\'s k:<kind> vs the answer\'s classified task kind): agree 2 · differ 1 · unstamped 1 · no title kind 4')).toBe(true);
    // merged: the new kind buckets land beside the stored ones (the old explain bucket kept, lanes replaced by the newer run)
    const [, , value] = store.storePut.mock.calls[0] as any[];
    expect(Object.keys(value.models['glm-5.3'].kinds).sort()).toEqual(['code', 'explain', 'planning', 'writing']);
    expect(value.models['glm-5.3'].kinds.explain.runId).toBe('r0');
    expect(value.models['deepseek-flash'].kinds.code.runId).toBe('mbk');
    expect(value.runs).toEqual(['r0', 'mbk']);
    // aggregates only — no question / answer text in the result or the log
    expect(JSON.stringify(out.result) + lines.join('\n')).not.toMatch(/linked list|toast|plan my week|deep dive/i);
  });

  it('an older deployed leaf that cannot parse `k:<kind>` titles is NAMED (deploy order), never silently dropped', async () => {
    const f = fixtures();
    const chats0 = f.prisma.crossModelChat.findMany.getMockImplementation();
    f.prisma.crossModelChat.findMany.mockImplementation(async (q: any) => [...(await chats0(q)), { id: 'k1', title: 'model-bench mb1 q5 glm-5.3 k:code' }]);
    // the pre-2026-10-20 parser: no optional token
    const oldParse = (t: unknown) => {
      const m = String(t ?? '').match(/^model-bench (\S+) q(\d+) (\S+)$/);
      return m && Number(m[2]) >= 1 ? { runId: m[1], questionIdx: Number(m[2]), spec: m[3] } : null;
    };
    const out = await script.run({ argv: ['--run-id', 'mb1', '--no-judge'], deps: { ...f.deps, leaf: { ...leaf, parseBenchTitle: oldParse } }, log: f.log });
    expect(out.result.skipped.otherTitle).toBe(2); // the preflight chat + the unparsed kind title
    expect(f.lines.some((l) => /⚠ 1 chat title\(s\) carry a `k:<kind>` task-kind token this box's scorecard leaf cannot parse/.test(l))).toBe(true);
    const g = fixtures();
    await script.run({ argv: ['--run-id', 'mb1', '--no-judge'], deps: g.deps, log: g.log });
    expect(g.lines.some((l) => /task-kind token this box/.test(l))).toBe(false); // the preflight chat alone never triggers it
  });

  it('kindAgreement counts only (pure)', () => {
    expect(script.kindAgreement([{ kind: 'code', planKind: 'code' }, { kind: 'code', planKind: 'explain' }, { kind: 'writing' }, { planKind: 'lookup' }, {}])).toEqual({ agree: 1, differ: 1, unstamped: 1, noTitleKind: 2 });
    expect(script.kindAgreement([])).toEqual({ agree: 0, differ: 0, unstamped: 0, noTitleKind: 0 });
  });
});

// ── judge v2 (2026-10-20, owner: "fix the model benchmarks") ─────────────────────────────────────────────────────────
// The single qwen judge rewarded LENGTH (the longest-answering model won every kind; a blind two-pass re-judge
// disagreed). v2 = a family-excluding judge PANEL on the length-blind rubric, K Latin-square ballots per judge (pairwise scores),
// complete rankings only, a per-answer quorum, and the length / position diagnostics in RESULT.
describe('model-bench-ingest judge v2', () => {
  type Cell = { q: number; spec: string; text: string; kind?: string };
  const bench = (cells: Cell[], runId = 'mb2') => {
    const chats = cells.map((c, i) => ({ id: `z${i + 1}`, title: `model-bench ${runId} q${c.q} ${c.spec}${c.kind ? ` k:${c.kind}` : ''}` }));
    const msgs: Record<string, any[]> = {};
    cells.forEach((c, i) => { msgs[`z${i + 1}`] = [user(`zu${i + 1}`, `question number ${c.q}`), answer(`za${i + 1}`, c.spec, {}, c.text)]; });
    const stored: Record<string, any> = {};
    const store = {
      storeGet: jest.fn(async (ns: string[], key: string) => stored[`${ns.join(':')}/${key}`] ?? null),
      storePut: jest.fn(async (ns: string[], key: string, value: any) => { stored[`${ns.join(':')}/${key}`] = value; }),
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ id: 'u-bot' })) },
      crossModelChat: { findMany: jest.fn(async ({ where }: any) => chats.filter((c) => c.title.startsWith(where.title.startsWith))) },
      crossModelMessage: { findMany: jest.fn(async ({ where }: any) => msgs[where.chatId] ?? []) },
    };
    const lines: string[] = [];
    const absolute = jest.fn(async () => ({ score: 3, issue: 'none' }));
    const deps = (extra: Record<string, any> = {}) => ({ leaf, prisma, store, judge: absolute, judgeModel: async () => 'deepseek-flash', deleteChat: jest.fn(async () => undefined), sleep: async () => {}, ...extra });
    return { chats, store, stored, lines, absolute, deps, log: (l: string) => lines.push(l) };
  };
  // a judge that ranks by a score of the answer TEXT — position-independent, so the assertions are shuffle-proof
  const rankBy = (score: (text: string) => number) => jest.fn(async (_q: string, answers: any[], _spec: string, _opts?: any) =>
    [...answers].sort((x: any, y: any) => score(y.answer) - score(x.answer)).map((a: any) => a.label));
  const quality = (t: string) => (/best/.test(t) ? 3 : /good/.test(t) ? 2 : 1);
  // glm / deepseek / kimi on two questions; kimi best, glm good, deepseek weak AND the longest (the length-bias shape)
  const threeModels = (kind?: string): Cell[] => [1, 2].flatMap((q) => [
    { q, spec: 'glm-5.3', text: `good answer for q${q}`, kind },
    { q, spec: 'deepseek-flash', text: `weak answer q${q} with lots and lots of padding`, kind },
    { q, spec: 'kimi-k3', text: `best answer q${q}`, kind },
  ]);
  const callsOf = (fn: jest.Mock) => fn.mock.calls.map((c: any[]) => ({ q: c[0], texts: c[1].map((a: any) => a.answer), labels: c[1].map((a: any) => a.label), spec: c[2], opts: c[3] }));
  const qualityOf = (out: any, spec: string) => out.result.scorecard.models[spec].lanes.all.quality;

  it('the DEFAULT: a family-excluding panel, K Latin-square + relabelled ballots per judge per question, v2 rubric, pairwise win rates onto 1..5, buckets stamped', async () => {
    expect([...script.DEFAULT_JUDGE_PANEL]).toEqual(['qwen3.6-27b', 'deepseek-flash']);
    const b = bench(threeModels());
    const onModel = rankBy(quality);
    const out = await script.run({ argv: ['--run-id', 'mb2'], deps: b.deps({ judgeComparativeOnModel: onModel }), log: b.log });
    expect(out.exitCode).toBe(0);
    const calls = callsOf(onModel);
    expect(calls).toHaveLength(10); // 2 questions × (qwen: 3 answers → 3 ballots + deepseek: 2 answers → 2 ballots)
    expect(calls.every((c) => JSON.stringify(c.opts) === JSON.stringify({ rubric: 'v2' }))).toBe(true);
    // SELF-FAMILY EXCLUSION: the deepseek judge never sees the deepseek answer; the qwen judge (no qwen candidate) sees all three
    expect(calls.filter((c) => c.spec === 'deepseek-flash').every((c) => c.texts.length === 2 && !c.texts.some((t: string) => /weak/.test(t)))).toBe(true);
    expect(calls.filter((c) => c.spec === 'qwen3.6-27b').every((c) => c.texts.length === 3)).toBe(true);
    // K ballots per (question, judge), each a rotation of the first (K = 2: the exact reverse), all relabelled A, B, C by position
    for (const q of ['question number 1', 'question number 2']) {
      for (const spec of ['qwen3.6-27b', 'deepseek-flash']) {
        const set = calls.filter((c) => c.q === q && c.spec === spec);
        const k = set[0].texts.length;
        expect(set).toHaveLength(k);
        set.forEach((c, o) => {
          expect(c.texts).toEqual([...set[0].texts.slice(o), ...set[0].texts.slice(0, o)]);
          expect(c.labels).toEqual(['A', 'B', 'C'].slice(0, k));
        });
        if (k === 2) expect(set[1].texts).toEqual([...set[0].texts].reverse());
      }
    }
    expect(b.absolute).not.toHaveBeenCalled(); // v2 never scores absolute
    // pairwise: kimi beats glm (5/5 ballots) and deepseek (3/3) → 5 · glm loses to kimi, beats deepseek (3/3) → 3 ·
    // deepseek loses both → 1 (a plain mean of per-ballot scores gave glm 2: the deepseek judge's 2-answer ballots
    // counted its loss to kimi as a full last place)
    expect([qualityOf(out, 'kimi-k3'), qualityOf(out, 'glm-5.3'), qualityOf(out, 'deepseek-flash')]).toEqual([5, 3, 1]);
    for (const spec of ['kimi-k3', 'glm-5.3', 'deepseek-flash']) {
      expect(out.result.scorecard.models[spec].lanes.all).toMatchObject({ qualityN: 2, qualityJudge: 'v2:2xK' });
      expect(typeof out.result.scorecard.models[spec].lanes.all.answerCharsP50).toBe('number');
    }
    expect(out.result).toMatchObject({
      judgeVersion: 'v2', panel: ['qwen3.6-27b', 'deepseek-flash'], ballotDesign: 'cyclic-latin-square', minBallots: 2, ballots: 10, ballotsFailed: 0, judgeSkips: 0,
      unrankableGroups: 0, unrankableAnswers: 0,
      judged: 6, judgedComparative: 6, judgedAbsolute: 0, comparativeGroups: 2, comparativeFailedGroups: 0, judgeFailed: 0, judgeModel: null, judgeSpec: null,
      positionConsistency: { 'qwen3.6-27b': { pairs: 6, tau: 1, top1: 1 }, 'deepseek-flash': { pairs: 2, tau: 1, top1: 1 } },
      // the longest answer (deepseek's) scored LOWEST on both questions: ρ = −1, it never won (chance 1/3)
      lengthRho: -1, lengthRhoGroups: 2, longestWonRate: 0, longestWonBaseline: 0.3333, longestWonGroups: 2,
    });
    expect('orders' in out.result).toBe(false);
    expect('perQuestion' in out.result).toBe(false);
    expect('lengthBeta' in out.result).toBe(false);
    expect(b.lines.some((l) => /^judge: v2 — panel qwen3\.6-27b \+ deepseek-flash \(the default panel\) · COMPARATIVE_RUBRIC_V2/.test(l))).toBe(true);
    expect(b.lines.some((l) => /K ballots per judge per question, K = the answers it ranks \(a cyclic Latin square/.test(l))).toBe(true);
    expect(b.lines.some((l) => /ballots 10 cast, 0 failed/.test(l))).toBe(true);
    expect(b.lines.some((l) => /^judge v2 diagnostics: position consistency .* qwen3\.6-27b τ 1 · top-1 1 \(n 6\) · deepseek-flash τ 1 · top-1 1 \(n 2\) · length ρ .* -1 over 2 group\(s\) · longest answer won 0 \(chance 0\.3333, 2 group\(s\)\)$/.test(l))).toBe(true);
    // aggregates only — no question / answer text in the result or the log
    expect(JSON.stringify(out.result) + b.lines.join('\n')).not.toMatch(/question number|answer for|padding|best answer/);
  });

  it('a position-biased judge (always A, B, C…) disagrees with itself across the Latin square (τ < 0, top-1 0) and every answer lands near 3, the residual averaging out over questions', async () => {
    const b = bench(threeModels());
    const positional = jest.fn(async (_q: string, answers: any[]) => answers.map((a: any) => a.label));
    const out = await script.run({ argv: ['--run-id', 'mb2'], deps: b.deps({ judgeComparativeOnModel: positional }), log: b.log });
    // K = 3 rotations of a positional ranking agree at τ = −1/3; K = 2 (shuffle + reverse) at −1; never on the top answer
    expect(out.result.positionConsistency).toEqual({ 'qwen3.6-27b': { pairs: 6, tau: -0.3333, top1: 0 }, 'deepseek-flash': { pairs: 2, tau: -1, top1: 0 } });
    // each answer's mean over the qwen judge's square is exactly ½; pooled with the deepseek judge's 2-answer ballots
    // (one pair only) a small per-question residual is left — its sign follows the seeded shuffle, so it averages out
    // (the one-judge panel case is exact: see the Latin-square test below)
    for (const spec of ['kimi-k3', 'glm-5.3', 'deepseek-flash']) expect(Math.abs(qualityOf(out, spec) - 3)).toBeLessThanOrEqual(0.15);
    const sum: Record<string, number> = {};
    for (let q = 1; q <= 200; q += 1) {
      const rows = [{ spec: 'glm-5.3', chatId: 'g' }, { spec: 'deepseek-flash', chatId: 'd' }, { spec: 'kimi-k3', chatId: 'k' }];
      const plan = script.ballotsFor({ questionIdx: q, rows }, script.DEFAULT_JUDGE_PANEL, { runId: 'sim' });
      const agg = script.aggregateBallots(plan.ballots.map((x: any) => ({ ranked: x.pairs.map((p: any) => p.row.chatId) })));
      for (const [id, v] of Object.entries(agg) as Array<[string, any]>) sum[id] = (sum[id] || 0) + v.quality / 200;
    }
    for (const id of ['g', 'd', 'k']) expect(Math.abs(sum[id] - 3)).toBeLessThan(0.05);
  });

  it('complete rankings only: a partial ranking is a FAILED ballot (retried); a lost ballot that keeps the quorum is counted, not fatal', async () => {
    // every ballot answers ['B'] first (v1 would have filled A and C in by position), then the full ranking
    const b = bench(threeModels());
    const seen = new Set<string>();
    const full = rankBy(quality);
    const partialFirst = jest.fn(async (q: string, answers: any[], spec: string, opts?: any) => {
      const key = `${spec}|${answers.map((a: any) => a.answer).join('|')}`;
      if (!seen.has(key)) { seen.add(key); return ['B']; }
      return full(q, answers, spec, opts);
    });
    const out = await script.run({ argv: ['--run-id', 'mb2'], deps: b.deps({ judgeComparativeOnModel: partialFirst, isTTY: false }), log: b.log });
    expect(out.exitCode).toBe(0);
    expect(partialFirst).toHaveBeenCalledTimes(20);
    expect(out.result).toMatchObject({ ballots: 10, ballotsFailed: 0, comparativeRetries: 10, comparativeGroups: 2 });
    expect([qualityOf(out, 'kimi-k3'), qualityOf(out, 'glm-5.3'), qualityOf(out, 'deepseek-flash')]).toEqual([5, 3, 1]);

    // the deepseek judge only ever answers a partial ranking → its 4 ballots fail after 3 attempts each; the qwen
    // ballots alone give every answer 3 ballots ≥ the quorum → UNATTENDED still writes (the lost ballots are counted)
    const k = bench(threeModels());
    const dsPartial = jest.fn(async (q: string, answers: any[], spec: string, opts?: any) => (spec === 'deepseek-flash' ? ['A'] : full(q, answers, spec, opts)));
    const outK = await script.run({ argv: ['--run-id', 'mb2', '--apply'], deps: k.deps({ judgeComparativeOnModel: dsPartial, isTTY: false }), log: k.log });
    expect(outK.exitCode).toBe(0);
    expect(outK.result).toMatchObject({ ballots: 6, ballotsFailed: 4, comparativeRetries: 8, comparativeGroups: 2, comparativeFailedGroups: 0, applied: true });
    expect([qualityOf(outK, 'kimi-k3'), qualityOf(outK, 'glm-5.3'), qualityOf(outK, 'deepseek-flash')]).toEqual([5, 3, 1]); // qwen ballots only: 1 / 0.5 / 0
    expect(k.store.storePut).toHaveBeenCalledTimes(1);
  });

  it('quorum LOST (a rankable group whose ballots FAILED below --min-ballots): unattended REFUSES (exit 1, nothing written); attended leaves those answers UNJUDGED with a ⚠ — never absolute', async () => {
    const full = rankBy(quality);
    const dead = (judge: string, fn: any) => jest.fn(async (q: string, answers: any[], spec: string, opts?: any) => (spec === judge ? null : fn(q, answers, spec, opts)));
    // --min-ballots 3: the plan reaches it (glm / kimi 3 + 2, deepseek 3 — the qwen judge's square) — but the qwen route is dead
    const u = bench(threeModels());
    const outU = await script.run({ argv: ['--run-id', 'mb2', '--apply', '--cleanup', '--min-ballots', '3'], deps: u.deps({ judgeComparativeOnModel: dead('qwen3.6-27b', full), isTTY: false }), log: u.log });
    expect(outU).toMatchObject({ exitCode: 1 });
    expect(outU.result).toBeUndefined();
    expect(String(outU.error)).toMatch(/2 question group\(s\) lost quorum .*fewer than 3 successful ballot\(s\).*6 ballot\(s\) failed after 3 attempt\(s\) each/);
    expect(String(outU.error)).toMatch(/28d9e351/);
    expect(u.store.storePut).not.toHaveBeenCalled();
    expect(u.absolute).not.toHaveBeenCalled();
    // the plan COULD reach the quorum for the full field: no per-candidate pre-flight line, no unrankable group — the
    // failed ballots sank the groups (the pre-flight still names the PAIRS a quorum of 3 could not rank, e.g. glm + deepseek)
    expect(u.lines.some((l) => /⚠ .*can get at most/.test(l) || /^unrankable:/.test(l))).toBe(false);
    expect(u.lines.some((l) => /⚠ a question only glm-5\.3 and deepseek-flash answered is UNRANKABLE: at most 2 ballot\(s\), below the quorum of 3/.test(l))).toBe(true);
    // attended: writes, says so, and the lost groups' answers carry no quality (no absolute scale mixed in)
    const a = bench(threeModels());
    const outA = await script.run({ argv: ['--run-id', 'mb2', '--min-ballots', '3'], deps: a.deps({ judgeComparativeOnModel: dead('qwen3.6-27b', full), isTTY: true }), log: a.log });
    expect(outA.exitCode).toBe(0);
    expect(outA.result).toMatchObject({ comparativeGroups: 0, comparativeFailedGroups: 2, unrankableGroups: 0, judged: 0, judgedAbsolute: 0, ballotsFailed: 6 });
    expect(a.absolute).not.toHaveBeenCalled();
    expect(outA.result.scorecard.models['kimi-k3'].lanes.all).toMatchObject({ quality: null, qualityN: 0 });
    expect('qualityJudge' in outA.result.scorecard.models['kimi-k3'].lanes.all).toBe(false);
    expect(a.lines.some((l) => /⚠ 2 question group\(s\) lost quorum — their answers carry NO quality/.test(l))).toBe(true);
    // --min-ballots 4 is out of the PLAN's reach (deepseek can get at most the qwen judge's 3): said up front, every group
    // UNRANKABLE — no judge call at all, and an unattended run refuses as "nothing ranked", never as failed ballots
    const p = bench(threeModels());
    const never = rankBy(quality);
    const outP = await script.run({ argv: ['--run-id', 'mb2', '--min-ballots', '4'], deps: p.deps({ judgeComparativeOnModel: never, isTTY: false }), log: p.log });
    expect(outP.exitCode).toBe(1);
    expect(String(outP.error)).toMatch(/no question group could be ranked \(0 comparative groups: 2 group\(s\) UNRANKABLE/);
    expect(never).not.toHaveBeenCalled();
    expect(p.lines.some((l) => /⚠ deepseek-flash \(deepseek\) can get at most 3 ballot\(s\) — below the quorum of 4/.test(l))).toBe(true);
    // the default quorum (2) with a dead deepseek route: kept (the qwen judge's square gives every answer 3 ballots)
    const d = bench(threeModels());
    expect((await script.run({ argv: ['--run-id', 'mb2'], deps: d.deps({ judgeComparativeOnModel: dead('deepseek-flash', full), isTTY: false }), log: d.log })).exitCode).toBe(0);
  });

  it('length diagnostics on long-wins data (ρ = 1, the longest always wins) and --length-control removes the slope (β > 0, scores pulled to the middle, stamp +lc)', async () => {
    // the judge ranks the LONGEST answer first; which model is longest differs per question
    const cells: Cell[] = [
      { q: 1, spec: 'glm-5.3', text: 'g'.repeat(3000) }, { q: 1, spec: 'deepseek-flash', text: 'd'.repeat(400) }, { q: 1, spec: 'kimi-k3', text: 'k'.repeat(50) },
      { q: 2, spec: 'glm-5.3', text: 'g'.repeat(60) }, { q: 2, spec: 'deepseek-flash', text: 'd'.repeat(500) }, { q: 2, spec: 'kimi-k3', text: 'k'.repeat(2500) },
    ];
    const b = bench(cells);
    const out = await script.run({ argv: ['--run-id', 'mb2', '--per-question'], deps: b.deps({ judgeComparativeOnModel: rankBy((t) => t.length) }), log: b.log });
    expect(out.result).toMatchObject({ lengthRho: 1, lengthRhoGroups: 2, longestWonRate: 1, longestWonBaseline: 0.3333 });
    const raw = out.result.perQuestion;
    const lc = bench(cells);
    const outLc = await script.run({ argv: ['--run-id', 'mb2', '--length-control', '--per-question'], deps: lc.deps({ judgeComparativeOnModel: rankBy((t) => t.length) }), log: lc.log });
    expect(outLc.result.lengthBeta).toBeGreaterThan(0.1); // the pairwise scale: β per unit of mean ln-length gap to the opponents
    expect(outLc.result).toMatchObject({ lengthRhoRaw: 1, longestWonRateRaw: 1 });
    const spread = (pq: any[]) => Math.max(...pq.map((g: any) => Math.max(...Object.values(g.scores as Record<string, number>)) - Math.min(...Object.values(g.scores as Record<string, number>))));
    expect(spread(raw)).toBe(4);
    expect(spread(outLc.result.perQuestion)).toBeLessThan(0.5); // the length part is gone; these answers differed only in length
    expect(outLc.result.scorecard.models['glm-5.3'].lanes.all.qualityJudge).toBe('v2:2xK+lc');
    expect(lc.lines.some((l) => /length control β 0\.\d+ \(before it: ρ 1, longest won 1\)/.test(l))).toBe(true);
  });

  it('--per-question: one compact { q, kind, scores, chars } entry per ranked question — numbers and specs only, never text', async () => {
    const b = bench(threeModels('code'), 'mbq');
    const out = await script.run({ argv: ['--run-id', 'mbq', '--per-question'], deps: b.deps({ judgeComparativeOnModel: rankBy(quality) }), log: b.log });
    const pq = out.result.perQuestion;
    expect(pq).toHaveLength(2);
    expect(pq.map((x: any) => x.q).sort()).toEqual([1, 2]);
    for (const x of pq) {
      expect(Object.keys(x).sort()).toEqual(['chars', 'kind', 'q', 'scores']);
      expect(x.kind).toBe('code');
      expect(x.scores).toEqual({ 'glm-5.3': 3, 'deepseek-flash': 1, 'kimi-k3': 5 });
      expect(x.chars).toEqual({ 'glm-5.3': `good answer for q${x.q}`.length, 'deepseek-flash': `weak answer q${x.q} with lots and lots of padding`.length, 'kimi-k3': `best answer q${x.q}`.length });
    }
    // the kind buckets carry the stamp too
    expect(out.result.scorecard.models['kimi-k3'].kinds.code).toMatchObject({ quality: 5, qualityJudge: 'v2:2xK', fieldSize: 3 });
    expect(JSON.stringify(out.result)).not.toMatch(/question number|answer for|padding|best answer/);
  });

  it('--judge-concurrency counts judge CALLS (v2 default 8); --judge-panel pins the panel; --judge-model alone is a ONE-judge panel', async () => {
    let inFlight = 0, peak = 0;
    const slow = jest.fn(async (_q: string, answers: any[]) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [...answers].sort((x: any, y: any) => quality(y.answer) - quality(x.answer)).map((a: any) => a.label);
    });
    const b = bench(threeModels());
    await script.run({ argv: ['--run-id', 'mb2'], deps: b.deps({ judgeComparativeOnModel: slow }), log: b.log });
    expect(peak).toBe(8);
    expect(b.lines.some((l) => / · 8 judge call\(s\) at a time$/.test(l))).toBe(true);
    peak = 0;
    const c = bench(threeModels());
    await script.run({ argv: ['--run-id', 'mb2', '--judge-concurrency', '2'], deps: c.deps({ judgeComparativeOnModel: slow }), log: c.log });
    expect(peak).toBe(2);
    // a pinned 3-judge panel: the gpt-oss judge (its own family) ranks all three answers
    const p = bench(threeModels());
    const outP = await script.run({ argv: ['--run-id', 'mb2', '--judge-panel', 'qwen3.6-27b,deepseek-flash,cql-litellm:gpt-oss-120b', '--judge-model', 'glm-5.3'], deps: p.deps({ judgeComparativeOnModel: rankBy(quality) }), log: p.log });
    expect(outP.result).toMatchObject({ panel: ['qwen3.6-27b', 'deepseek-flash', 'cql-litellm:gpt-oss-120b'], ballots: 16 }); // per question: qwen 3 + deepseek 2 + gpt-oss 3 (its own family ranks all three)
    expect(outP.result.scorecard.models['kimi-k3'].lanes.all.qualityJudge).toBe('v2:3xK');
    expect(p.lines.some((l) => /\(--judge-panel; --judge-model glm-5\.3 ignored\)/.test(l))).toBe(true);
    // --judge-model under v2 = a one-judge panel; a candidate of its family can never be ranked → every group UNRANKABLE, said up front
    const m = bench(threeModels());
    const outM = await script.run({ argv: ['--run-id', 'mb2', '--judge-model', 'deepseek-flash'], deps: m.deps({ judgeComparativeOnModel: rankBy(quality) }), log: m.log });
    expect(outM.result).toMatchObject({ panel: ['deepseek-flash'], comparativeGroups: 0, comparativeFailedGroups: 0, unrankableGroups: 2, ballots: 0 }); // unrankable at plan time: no call
    expect(m.lines.some((l) => /\(--judge-model: a ONE-judge panel/.test(l))).toBe(true);
    expect(m.lines.some((l) => /⚠ deepseek-flash \(deepseek\) can get at most 0 ballot\(s\) — every panel judge shares its family/.test(l))).toBe(true);
    // a non-streaming-unsafe / frontier judge pinned by hand is said out loud
    const w = bench(threeModels());
    await script.run({ argv: ['--run-id', 'mb2', '--judge-panel', 'kimi-k3,cql-litellm:api-anthropic-claude-fable-5-1'], deps: w.deps({ judgeComparativeOnModel: rankBy(quality) }), log: w.log });
    expect(w.lines.some((l) => /⚠ judge kimi-k3 always reasons and must STREAM/.test(l))).toBe(true);
    expect(w.lines.some((l) => /⚠ judge cql-litellm:api-anthropic-claude-fable-5-1 is a frontier model \(claude\)/.test(l))).toBe(true);
  });

  it('an UNATTENDED v2 run needs no --judge-model: the default panel judges (no single-judge pin); v2 refuses a build without the v2 judge (exit 3)', async () => {
    const b = bench(threeModels());
    const out = await script.run({ argv: ['--run-id', 'mb2', '--apply'], deps: b.deps({ judgeComparativeOnModel: rankBy(quality), isTTY: false }), log: b.log });
    expect(out.exitCode).toBe(0);
    expect(out.result).toMatchObject({ panel: ['qwen3.6-27b', 'deepseek-flash'], applied: true });
    expect(b.lines.some((l) => /pinning the comparative judge to the default/.test(l))).toBe(false);
    const [, , value] = b.store.storePut.mock.calls[0] as any[];
    expect(value.models['kimi-k3'].lanes.all).toMatchObject({ quality: 5, qualityJudge: 'v2:2xK' });
    // a build without comparativeJudgeOnModel, or whose audit module predates COMPARATIVE_RUBRIC_V2 → exit 3, nothing read
    const n = bench(threeModels());
    const noModel = await script.run({ argv: ['--run-id', 'mb2'], deps: n.deps({ judgeComparative: jest.fn() }), log: n.log });
    expect(noModel).toMatchObject({ exitCode: 3, error: expect.stringMatching(/judge v2 needs live-chat-audit\.comparativeJudgeOnModel .*--judge-version v1/) });
    const old = await script.run({ argv: ['--run-id', 'mb2'], deps: n.deps({ judgeComparativeOnModel: jest.fn(), rubricV2: false }), log: n.log });
    expect(old).toMatchObject({ exitCode: 3 });
    expect(n.store.storeGet).not.toHaveBeenCalled();
    // --no-judge never needs a judge
    expect((await script.run({ argv: ['--run-id', 'mb2', '--no-judge'], deps: n.deps({ rubricV2: false }), log: n.log })).exitCode).toBe(0);
  });

  // The restore path: --judge-version v1 reproduces today's single judge EXACTLY. The expected values below were
  // captured by running the PRE-v2 script (base 204c0efb) on this same fixture — its calls (3 args, no rubric option),
  // its position-filled partial ranking, its 5/3/1 ranks, its log lines and its RESULT keys (no v2 keys).
  it('--judge-version v1 is byte-identical to the pre-v2 ingest (calls, the partial-ranking position fill, scores, log, RESULT)', async () => {
    const vAnswer = (id: string, modelUsed: string, content: string, ttft = 4000) => ({
      id, role: 'assistant', content, createdAt: new Date('2026-10-04T10:00:30Z'),
      metadata: { models: { digby: { modelUsed } }, depth: { turnPlan: { lane: 'standard' }, plan: { preset: 'single_thinking' } }, ux: { ttftMs: ttft, completionMs: 12000 } },
    });
    const chats = [
      { id: 'v1', title: 'model-bench mbv q1 glm-5.3' }, { id: 'v2', title: 'model-bench mbv q1 deepseek-flash' }, { id: 'v3', title: 'model-bench mbv q1 kimi-k3' },
      { id: 'v4', title: 'model-bench mbv q2 glm-5.3' }, { id: 'v5', title: 'model-bench mbv q2 deepseek-flash' }, { id: 'v6', title: 'model-bench mbv q2 kimi-k3' },
    ];
    const msgs: Record<string, any[]> = {
      v1: [user('u1', 'first question'), vAnswer('a1', 'glm-5.3', 'glm one, medium length answer.')],
      v2: [user('u2', 'first question'), vAnswer('a2', 'deepseek-flash', 'deepseek one, the very longest answer of the three on this question.', 2000)],
      v3: [user('u3', 'first question'), vAnswer('a3', 'kimi-k3', 'kimi one short.', 9000)],
      v4: [user('u4', 'second question'), vAnswer('a4', 'glm-5.3', 'glm two.')],
      v5: [user('u5', 'second question'), vAnswer('a5', 'deepseek-flash', 'deepseek two, longer than the others here.', 2000)],
      v6: [user('u6', 'second question'), vAnswer('a6', 'kimi-k3', 'kimi two, mid.', 9000)],
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ id: 'u-bot' })) },
      crossModelChat: { findMany: jest.fn(async ({ where }: any) => chats.filter((c) => c.title.startsWith(where.title.startsWith))) },
      crossModelMessage: { findMany: jest.fn(async ({ where }: any) => msgs[where.chatId] ?? []) },
    };
    const store = { storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) };
    const calls: any[] = [];
    const onModel = jest.fn(async (...a: any[]) => {
      calls.push(a);
      const [q, answers] = a;
      if (q === 'first question') return ['B']; // a partial ranking: v1 appends the rest by presentation order
      return [...answers].sort((x: any, y: any) => y.answer.length - x.answer.length).map((x: any) => x.label);
    });
    const lines: string[] = [];
    const out = await script.run({ argv: ['--run-id', 'mbv', '--judge-version', 'v1', '--judge-model', 'gpt-oss-120b', '--judge-concurrency', '1'], env: {}, deps: { leaf, prisma, store, judge: jest.fn(async () => ({ score: 3, issue: 'none' })), judgeModel: async () => 'deepseek-flash', judgeComparativeOnModel: onModel, sleep: async () => {} }, log: (l: string) => lines.push(l) });
    expect(calls).toEqual([
      ['first question', [{ label: 'A', answer: 'kimi one short.' }, { label: 'B', answer: 'deepseek one, the very longest answer of the three on this question.' }, { label: 'C', answer: 'glm one, medium length answer.' }], 'gpt-oss-120b'],
      ['second question', [{ label: 'A', answer: 'kimi two, mid.' }, { label: 'B', answer: 'glm two.' }, { label: 'C', answer: 'deepseek two, longer than the others here.' }], 'gpt-oss-120b'],
    ]); // three arguments — never a rubric option
    expect(lines.map((l) => l.replace(/in \d+ s/, 'in N s'))).toEqual([
      'run mbv: 6 chat(s), 6 bench row(s) (skipped: 0 other title, 0 never sent)',
      'judge: comparative judge PINNED to gpt-oss-120b (--judge-model)',
      'judge: live-chat-audit COMPARATIVE_RUBRIC — blind: answers grouped per question, labels A/B/C…, presentation order seeded-shuffled on gpt-oss-120b',
      'judged 6/6 measured answer(s) over 2 group(s) in N s — 2 comparative group(s) (6 row(s)), 0 absolute row(s)',
      'deepseek-flash  (measured 2 · failed 0 · failover 0 · diverted 0 · unverified 0)',
      '  all       n   2 · ttft p50 2000 ms p90 2000 ms · done p50 12000 ms · fail 0 · quality 5 (2) · web tools -',
      '  standard  n   2 · ttft p50 2000 ms p90 2000 ms · done p50 12000 ms · fail 0 · quality 5 (2) · web tools -',
      'glm-5.3  (measured 2 · failed 0 · failover 0 · diverted 0 · unverified 0)',
      '  all       n   2 · ttft p50 4000 ms p90 4000 ms · done p50 12000 ms · fail 0 · quality 1 (2) · web tools -',
      '  standard  n   2 · ttft p50 4000 ms p90 4000 ms · done p50 12000 ms · fail 0 · quality 1 (2) · web tools -',
      'kimi-k3  (measured 2 · failed 0 · failover 0 · diverted 0 · unverified 0)',
      '  all       n   2 · ttft p50 9000 ms p90 9000 ms · done p50 12000 ms · fail 0 · quality 3 (2) · web tools -',
      '  standard  n   2 · ttft p50 9000 ms p90 9000 ms · done p50 12000 ms · fail 0 · quality 3 (2) · web tools -',
      'dry run — nothing written (pass --apply to merge this run into the scorecard)',
    ]);
    const { scorecard, ...rest } = out.result;
    expect(rest).toEqual({
      runId: 'mbv', chats: 6, rows: 6, skipped: { otherTitle: 0, unsent: 0 },
      attribution: { 'glm-5.3': { measured: 2 }, 'deepseek-flash': { measured: 2 }, 'kimi-k3': { measured: 2 } },
      judged: 6, judgedComparative: 6, judgedAbsolute: 0, comparativeGroups: 2, familyGuardGroups: 0, comparativeFailedGroups: 0,
      comparativeRetries: 0, judgeFailed: 0, singletonsUnjudged: 0, kindAgreement: { agree: 0, differ: 0, unstamped: 0, noTitleKind: 6 },
      judgeModel: 'deepseek-flash', judgeSpec: 'gpt-oss-120b', applied: false, deleted: 0,
    });
    // the buckets: the captured values; the leaf's additive answerCharsP50 (a measurement, not the judge) is the only new key
    const bucket = (spec: string) => { const { answerCharsP50, ...rest2 } = scorecard.models[spec].lanes.all; expect(typeof answerCharsP50).toBe('number'); return rest2; };
    const base = { n: 2, doneP50Ms: 12000, failRate: 0, qualityN: 2, runId: 'mbv', at: '2026-10-04T10:00:30.000Z' };
    expect(bucket('deepseek-flash')).toEqual({ ...base, ttftP50Ms: 2000, ttftP90Ms: 2000, quality: 5 });
    expect(bucket('glm-5.3')).toEqual({ ...base, ttftP50Ms: 4000, ttftP90Ms: 4000, quality: 1 });
    expect(bucket('kimi-k3')).toEqual({ ...base, ttftP50Ms: 9000, ttftP90Ms: 9000, quality: 3 }); // rank 2 — FILLED IN by presentation position (v1's leak, kept on purpose)
  });

  it('parseArgs: v2 by default; --judge-version / --judge-panel / --min-ballots / --length-control / --per-question and their env twins; refusals', () => {
    expect(script.parseArgs(['--run-id', 'mb1'], {})).toMatchObject({ judgeVersion: 'v2', judgePanel: null, minBallots: 2, lengthControl: false, perQuestion: false, judgeConcurrency: 4, judgeConcurrencySet: false, error: '' });
    expect(script.parseArgs(['--run-id', 'mb1', '--judge-version', 'V1'], {})).toMatchObject({ judgeVersion: 'v1', error: '' });
    expect(script.parseArgs(['--run-id', 'mb1', '--judge-concurrency', '3'], {})).toMatchObject({ judgeConcurrency: 3, judgeConcurrencySet: true });
    expect(script.parseArgs(['--run-id', 'mb1', '--judge-panel', 'qwen3.6-27b, deepseek-flash,qwen3.6-27b', '--min-ballots', '99', '--length-control', '--per-question'], {}))
      .toMatchObject({ judgePanel: ['qwen3.6-27b', 'deepseek-flash'], minBallots: 12, lengthControl: true, perQuestion: true, error: '' });
    expect(script.parseArgs(['--run-id', 'mb1', '--min-ballots', '0'], {})).toMatchObject({ minBallots: 1 });
    expect(script.parseArgs([], { RUN_ID: 'mb1', JUDGE_VERSION: 'v1' })).toMatchObject({ judgeVersion: 'v1', error: '' });
    expect(script.parseArgs([], { RUN_ID: 'mb1', JUDGE_PANEL: 'deepseek-flash,cql-litellm:gpt-oss-120b', MIN_BALLOTS: '3', LENGTH_CONTROL: '1', PER_QUESTION: 'true' }))
      .toMatchObject({ judgePanel: ['deepseek-flash', 'cql-litellm:gpt-oss-120b'], minBallots: 3, lengthControl: true, perQuestion: true });
    const err = (argv: string[], env = {}) => String(script.parseArgs(['--run-id', 'mb1', ...argv], env).error);
    expect(err(['--judge-version', 'v3'])).toMatch(/--judge-version must be v1 or v2/);
    expect(err(['--judge-version', 'v1', '--judge-panel', 'qwen3.6-27b'])).toMatch(/--judge-panel belongs to judge v2/);
    expect(err(['--judge-version', 'v1', '--length-control', '--per-question'])).toMatch(/--length-control \/ --per-question belong to judge v2/);
    expect(err(['--judge-version', 'v1', '--min-ballots', '2'])).toMatch(/--min-ballots belongs to judge v2/);
    expect(err(['--judge-version', 'v1'], { MIN_BALLOTS: '2' })).toMatch(/--min-ballots/);
    expect(err(['--judge-panel', 'qwen3.6-27b,qwen3.6-flash'])).toMatch(/DISTINCT model families \(families: qwen, qwen\)/);
    expect(err(['--judge-panel', 'cql-litellm:agx-laya,deepseek-flash'])).toMatch(/cannot name a decision model/);
    expect(err(['--judge-panel', 'qwen 27b'])).toMatch(/comma-separated model specs/);
    expect(err(['--judge-panel', 'qwen3.6-27b,deepseek-flash,glm-5.3-flash,kimi-k3,cql-litellm:gpt-oss-120b,cql-litellm:mistral-x,cql-litellm:llama-4'])).toMatch(/at most 6 judges/);
    expect(err(['--judge-version', 'v1', '--judge-model', 'qwen3.6-27b'])).toBe(''); // v1's own flags stay valid
  });

  it('pure helpers: ballotsFor (exclusion, Latin square, relabel, seeds, sit-outs), plannedBallotCounts, aggregateBallots (pairwise; incl. the K=3 single-ballot identity), requireComplete, lengthSlope, kendallTau, spearman, stamps', () => {
    const rows = [
      { questionIdx: 4, spec: 'glm-5.3', chatId: 'g' }, { questionIdx: 4, spec: 'deepseek-flash', chatId: 'd' },
      { questionIdx: 4, spec: 'kimi-k3', chatId: 'k' }, { questionIdx: 4, spec: 'cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash', chatId: 'd2' },
    ];
    const plan = script.ballotsFor({ questionIdx: 4, rows }, ['deepseek-flash', 'qwen3.6-27b'], { runId: 'r1' });
    expect(plan.skipped).toEqual([]);
    // K ballots per judge, K = the rows it ranks: deepseek 2 (its family's two rows left out), qwen 4
    expect(plan.ballots.map((b: any) => [b.judge, b.order, b.pairs.length])).toEqual([
      ['deepseek-flash', 0, 2], ['deepseek-flash', 1, 2], ['qwen3.6-27b', 0, 4], ['qwen3.6-27b', 1, 4], ['qwen3.6-27b', 2, 4], ['qwen3.6-27b', 3, 4],
    ]);
    // both deepseek-family rows (the gateway alias too) are excluded from the deepseek judge's ballots
    expect(plan.ballots.filter((b: any) => b.judge === 'deepseek-flash').flatMap((b: any) => b.pairs.map((p: any) => p.row.chatId)).sort()).toEqual(['g', 'g', 'k', 'k']);
    const ds = plan.ballots.filter((b: any) => b.judge === 'deepseek-flash').map((b: any) => b.pairs.map((p: any) => p.row.chatId));
    expect(ds[1]).toEqual([...ds[0]].reverse()); // K = 2: the rotation is the reverse
    const qw = plan.ballots.filter((b: any) => b.judge === 'qwen3.6-27b');
    const orders = qw.map((b: any) => b.pairs.map((p: any) => p.row.chatId));
    orders.forEach((o: string[], i: number) => expect(o).toEqual([...orders[0].slice(i), ...orders[0].slice(0, i)])); // ballot o = the shuffle rotated by o
    for (let slot = 0; slot < 4; slot += 1) expect(new Set(orders.map((o: string[]) => o[slot])).size).toBe(4); // a Latin square: every row once in every slot
    for (const b of qw) {
      expect(b.pairs.map((p: any) => p.label)).toEqual(['A', 'B', 'C', 'D']);
      expect([...b.labelToRow.keys()]).toEqual(['A', 'B', 'C', 'D']);
    }
    expect(Object.fromEntries(script.plannedBallotCounts(plan.ballots))).toEqual({ g: 6, k: 6, d: 4, d2: 4 });
    // deterministic per (run, question, judge); any judge's ballot covers every eligible row exactly once
    expect(script.ballotsFor({ questionIdx: 4, rows }, ['qwen3.6-27b'], { runId: 'r1' }).ballots.map((b: any) => b.pairs.map((p: any) => p.row.chatId))).toEqual(orders);
    expect(script.ballotsFor({ questionIdx: 4, rows }, ['cql-litellm:gpt-oss-120b'], { runId: 'r1' }).ballots[0].pairs.map((p: any) => p.row.chatId).sort()).toEqual(['d', 'd2', 'g', 'k']);
    // a judge left with < 2 rows sits out
    const two = [{ questionIdx: 1, spec: 'deepseek-flash', chatId: 'a' }, { questionIdx: 1, spec: 'glm-5.3', chatId: 'b' }];
    expect(script.ballotsFor({ questionIdx: 1, rows: two }, ['deepseek-flash', 'glm-5.3-flash'], { runId: 'r' })).toEqual({ ballots: [], skipped: ['deepseek-flash', 'glm-5.3-flash'] });

    // aggregateBallots: per-opponent pairwise win rates, averaged; quality = round2(1 + 4 · that mean)
    const K3 = script.aggregateBallots([{ ranked: ['x', 'y', 'z'] }]);
    expect([K3.x.quality, K3.y.quality, K3.z.quality]).toEqual([1, 2, 3].map((rank) => script.rankToQuality(rank, 3))); // = v1's 5 / 3 / 1
    expect([K3.x.quality, K3.y.quality, K3.z.quality]).toEqual([5, 3, 1]);
    expect(script.aggregateBallots([{ ranked: ['a', 'b'] }])).toEqual({ a: { ballots: 1, opponents: 1, winRate: 1, quality: 5 }, b: { ballots: 1, opponents: 1, winRate: 0, quality: 1 } }); // K=2 = v1's 5/1
    const K4 = script.aggregateBallots([{ ranked: ['a', 'b', 'c', 'd'] }]);
    expect([K4.a.quality, K4.b.quality, K4.c.quality, K4.d.quality]).toEqual([5, 3.67, 2.33, 1]); // unrounded — v1 had 5/4/2/1
    const swapped = script.aggregateBallots([{ ranked: ['x', 'y', 'z'] }, { ranked: ['z', 'y', 'x'] }]);
    expect(Object.values(swapped).map((v: any) => v.quality)).toEqual([3, 3, 3]); // a forward/reverse disagreement averages to the middle
    const mixed = script.aggregateBallots([{ ranked: ['x', 'y', 'z'] }, { ranked: ['x', 'z'] }]); // a ballot that excluded y's family
    expect(mixed).toEqual({ x: { ballots: 2, opponents: 2, winRate: 1, quality: 5 }, y: { ballots: 1, opponents: 2, winRate: 0.5, quality: 3 }, z: { ballots: 2, opponents: 2, winRate: 0, quality: 1 } });
    // complete ballots: pairwise = the mean of (k − r)/(k − 1) over the ballots (any mix of orders)
    const many = [{ ranked: ['a', 'b', 'c'] }, { ranked: ['b', 'a', 'c'] }, { ranked: ['c', 'a', 'b'] }];
    const meanS = (id: string) => many.reduce((s, b) => s + (2 - b.ranked.indexOf(id)) / 2, 0) / many.length;
    for (const id of ['a', 'b', 'c']) expect(script.aggregateBallots(many)[id].winRate).toBeCloseTo(meanS(id), 4);
    expect(script.aggregateBallots([{ ranked: ['solo'] }, { ranked: null }, null])).toEqual({});

    // lengthSlope (per question group): lengths e^0, e^1, e^2 ranked longest first → β = 1/3, and every answer then scores 3
    const chars = new Map([['s', 1], ['m', Math.exp(1)], ['l', Math.exp(2)]]);
    const longFirst = [{ ranked: ['l', 'm', 's'] }];
    expect(script.lengthSlope([longFirst], chars)).toBeCloseTo(1 / 3, 10);
    const adj = script.aggregateBallots(longFirst, { charsById: chars, beta: 1 / 3 });
    expect([adj.l.quality, adj.m.quality, adj.s.quality]).toEqual([3, 3, 3]);
    expect(script.lengthSlope([[{ ranked: ['s', 'm', 'l'] }]], chars)).toBeCloseTo(-1 / 3, 10); // short-wins = a negative slope
    expect(script.lengthSlope([[{ ranked: ['a', 'b'] }]], { a: 100, b: 100 })).toBe(0); // no length spread
    expect(script.aggregateBallots(longFirst, { charsById: { l: Math.exp(2), m: Math.exp(1), s: 1 }, beta: 5 }).l.winRate).toBe(0); // clamped to [0, 1]
    // the two sides of an adjusted pair still sum to 1
    const pairAdj = script.aggregateBallots([{ ranked: ['l', 's'] }], { charsById: chars, beta: 0.2 });
    expect(pairAdj.l.winRate + pairAdj.s.winRate).toBeCloseTo(1, 10);

    // kendallTau: per-answer agreement between two rankings (over the ids both hold)
    expect(script.kendallTau(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(script.kendallTau(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
    expect(script.kendallTau(['a', 'b', 'c'], ['b', 'c', 'a'])).toBeCloseTo(-1 / 3, 10);
    expect(script.kendallTau(['a', 'b'], ['b', 'x'])).toBeNull();

    // requireComplete: every label exactly once, nothing else
    const l2r = new Map([['A', { spec: 'glm-5.3' }], ['B', { spec: 'deepseek-flash' }], ['C', { spec: 'kimi-k3' }]]);
    expect(script.mapRankingToModels(['B'], l2r, { requireComplete: true })).toBeNull();
    expect(script.mapRankingToModels(['B', 'A', 'B'], l2r, { requireComplete: true })).toBeNull();
    expect(script.mapRankingToModels(['B', 'A', 'X'], l2r, { requireComplete: true })).toBeNull();
    expect(script.mapRankingToModels(['B', 'A', 'C', 'D'], l2r, { requireComplete: true })).toBeNull();
    expect(script.mapRankingToModels(['b', ' a', 'C'], l2r, { requireComplete: true })).toEqual([{ spec: 'deepseek-flash', rank: 1, label: 'B' }, { spec: 'glm-5.3', rank: 2, label: 'A' }, { spec: 'kimi-k3', rank: 3, label: 'C' }]);
    expect(script.mapRankingToModels({ ranking: ['C', 'B', 'A'] }, l2r, { requireComplete: true }).map((m: any) => m.label)).toEqual(['C', 'B', 'A']);
    expect(script.mapRankingToModels(['B'], l2r)).toEqual([{ spec: 'deepseek-flash', rank: 1, label: 'B' }, { spec: 'glm-5.3', rank: 2, label: 'A' }, { spec: 'kimi-k3', rank: 3, label: 'C' }]); // v1: unchanged (the position fill)

    // spearman / diagnostics / consistency / stamp
    expect(script.spearman([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
    expect(script.spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(script.spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(script.spearman([1], [1])).toBeNull();
    expect(script.lengthDiagnostics([[{ chars: 10, score: 1 }, { chars: 99, score: 5 }], [{ chars: 50, score: 5 }, { chars: 50, score: 1 }]]))
      .toEqual({ lengthRho: 1, lengthRhoGroups: 1, longestWonRate: 1, longestWonBaseline: 0.5, longestWonGroups: 1 }); // the equal-length group has no length spread (no ρ) and no single longest (left out)
    expect(script.lengthDiagnostics([[{ chars: 10, score: 1 }, { chars: 99, score: 5 }], [{ chars: 10, score: 5 }, { chars: 99, score: 1 }]]))
      .toEqual({ lengthRho: 0, lengthRhoGroups: 2, longestWonRate: 0.5, longestWonBaseline: 0.5, longestWonGroups: 2 }); // ρ +1 and −1 average to 0
    expect(script.lengthDiagnostics([])).toEqual({ lengthRho: null, lengthRhoGroups: 0, longestWonRate: null, longestWonBaseline: null, longestWonGroups: 0 });
    expect(script.positionConsistency([[{ judge: 'j', order: 0, ranked: ['a', 'b'] }, { judge: 'j', order: 1, ranked: ['a', 'b'] }], [{ judge: 'j', order: 0, ranked: ['a', 'b'] }, { judge: 'j', order: 1, ranked: ['b', 'a'] }], [{ judge: 'j', order: 0, ranked: ['a', 'b'] }, { judge: 'j', order: 1 }]], ['j', 'k']))
      .toEqual({ j: { pairs: 2, tau: 0, top1: 0.5 }, k: { pairs: 0, tau: null, top1: null } }); // τ +1 and −1 average to 0
    expect(script.qualityJudgeStamp(['a', 'b'])).toBe('v2:2xK');
    expect(script.qualityJudgeStamp(['a', 'b', 'c'], true)).toBe('v2:3xK+lc');
    // the default panel: open, distinct families, never a must-stream / reasoning-locked built-in; covers the usual candidates
    const fams = script.DEFAULT_JUDGE_PANEL.map(script.familyOf);
    expect(new Set(fams).size).toBe(fams.length);
    expect(script.DEFAULT_JUDGE_PANEL).not.toContain('kimi-k3');
    expect(script.DEFAULT_JUDGE_PANEL).not.toContain('glm-5.3');
    // every candidate CAN be ranked in the full field — but a question only the two panel families answered cannot
    expect(script.panelWarnings(script.DEFAULT_JUDGE_PANEL, ['glm-5.3', 'kimi-k3', 'deepseek-flash', 'qwen3.6-27b'])).toEqual([
      expect.stringMatching(/^a question only deepseek-flash and qwen3\.6-27b answered is UNRANKABLE: every panel judge shares a family with one of them/),
    ]);
    expect(script.panelWarnings(script.DEFAULT_JUDGE_PANEL, ['glm-5.3', 'kimi-k3', 'deepseek-flash'])).toEqual([]);
    // a quorum the plan can never reach for a pair: at most 2 ballots (one judge's K = 2 square) under a quorum of 3
    expect(script.panelWarnings(script.DEFAULT_JUDGE_PANEL, ['glm-5.3', 'deepseek-flash', 'kimi-k3'], { minBallots: 3 })).toEqual([
      expect.stringMatching(/^a question only glm-5\.3 and deepseek-flash answered is UNRANKABLE: at most 2 ballot\(s\), below the quorum of 3/),
      expect.stringMatching(/^a question only deepseek-flash and kimi-k3 answered is UNRANKABLE: at most 2 ballot\(s\), below the quorum of 3/),
    ]);
  });

  // ---- review fixes (2026-10-20): pairwise aggregation, the Latin-square ballots, unrankable groups ----

  // a judge that ranks by the answer's `rank<n>` token (higher first) — position-blind, so every ballot agrees
  const byRankToken = (t: string) => Number((/rank(\d)/.exec(t) || ['', '0'])[1]);

  it('equal true quality ⇒ equal scores: each answer scores its PAIRWISE win rate per opponent, so self-family exclusion cannot tilt the judge family\'s own candidate', async () => {
    // q1 true order ds > kimi > glm, q2 kimi > ds > glm: ds and kimi each win one question — the same true quality.
    // A plain mean of per-ballot (k − r)/(k − 1) gave kimi 4.5 and ds 4 (the deepseek judge's 2-answer ballots
    // counted kimi's "beat glm" as a full win and never saw ds); per-opponent win rates give both 4.
    const b = bench([
      { q: 1, spec: 'deepseek-flash', text: 'rank3 q1' }, { q: 1, spec: 'kimi-k3', text: 'rank2 q1' }, { q: 1, spec: 'glm-5.3', text: 'rank1 q1' },
      { q: 2, spec: 'kimi-k3', text: 'rank3 q2' }, { q: 2, spec: 'deepseek-flash', text: 'rank2 q2' }, { q: 2, spec: 'glm-5.3', text: 'rank1 q2' },
    ]);
    const out = await script.run({ argv: ['--run-id', 'mb2', '--per-question'], deps: b.deps({ judgeComparativeOnModel: rankBy(byRankToken) }), log: b.log });
    expect([qualityOf(out, 'deepseek-flash'), qualityOf(out, 'kimi-k3'), qualityOf(out, 'glm-5.3')]).toEqual([4, 4, 1]);
    // every question's true full order maps to 5 / 3 / 1, whichever family a judge left out
    const byQ = Object.fromEntries(out.result.perQuestion.map((x: any) => [x.q, x.scores]));
    expect(byQ[1]).toEqual({ 'deepseek-flash': 5, 'kimi-k3': 3, 'glm-5.3': 1 });
    expect(byQ[2]).toEqual({ 'kimi-k3': 5, 'deepseek-flash': 3, 'glm-5.3': 1 });
    // the reverse tilt: q1 kimi > ds > glm, q2 kimi > glm > ds — glm and ds each beat the other once (was ds 2, glm 1.5)
    const r = bench([
      { q: 1, spec: 'kimi-k3', text: 'rank3 q1' }, { q: 1, spec: 'deepseek-flash', text: 'rank2 q1' }, { q: 1, spec: 'glm-5.3', text: 'rank1 q1' },
      { q: 2, spec: 'kimi-k3', text: 'rank3 q2' }, { q: 2, spec: 'glm-5.3', text: 'rank2 q2' }, { q: 2, spec: 'deepseek-flash', text: 'rank1 q2' },
    ]);
    const outR = await script.run({ argv: ['--run-id', 'mb2'], deps: r.deps({ judgeComparativeOnModel: rankBy(byRankToken) }), log: r.log });
    expect([qualityOf(outR, 'kimi-k3'), qualityOf(outR, 'glm-5.3'), qualityOf(outR, 'deepseek-flash')]).toEqual([5, 2, 2]);
    // the pure aggregation: a ballot that left out d (its judge's family) only counts for the pair it holds
    const agg = script.aggregateBallots([{ ranked: ['d', 'k', 'g'] }, { ranked: ['d', 'k', 'g'] }, { ranked: ['k', 'g'] }]);
    expect([agg.d.quality, agg.k.quality, agg.g.quality]).toEqual([5, 3, 1]);
    expect(agg.k).toEqual({ ballots: 3, opponents: 2, winRate: 0.5, quality: 3 });
  });

  it('K ballots per judge per question — a cyclic Latin square (every answer once in every slot): a first-, middle- or last-preferring positional judge scores every answer the same and reads as inconsistent', async () => {
    const b = bench(threeModels());
    const onModel = rankBy(quality);
    const out = await script.run({ argv: ['--run-id', 'mb2'], deps: b.deps({ judgeComparativeOnModel: onModel }), log: b.log });
    const calls = callsOf(onModel);
    expect(calls).toHaveLength(10); // 2 questions × (qwen: 3 answers → 3 ballots + deepseek: 2 answers → 2 ballots)
    for (const q of ['question number 1', 'question number 2']) {
      for (const [spec, k] of [['qwen3.6-27b', 3], ['deepseek-flash', 2]] as const) {
        const set = calls.filter((c) => c.q === q && c.spec === spec);
        expect(set).toHaveLength(k);
        for (const c of set) expect(c.labels).toEqual(['A', 'B', 'C'].slice(0, k));
        // every slot holds every answer exactly once across the judge's ballots (the middle answer moves too)
        for (let slot = 0; slot < k; slot += 1) expect(new Set(set.map((c) => c.texts[slot])).size).toBe(k);
      }
    }
    expect(out.result.ballotDesign).toBe('cyclic-latin-square');
    // positional judges on a one-judge panel whose ballots are all complete: exactly 3 / 3 / 3 — and visibly inconsistent
    for (const pattern of [[0, 1, 2], [1, 0, 2], [2, 1, 0], [0, 2, 1]]) {
      const p = bench(threeModels());
      const positional = jest.fn(async (_q: string, answers: any[]) => pattern.map((i) => answers[i].label));
      const outP = await script.run({ argv: ['--run-id', 'mb2', '--judge-panel', 'qwen3.6-27b'], deps: p.deps({ judgeComparativeOnModel: positional }), log: p.log });
      expect([qualityOf(outP, 'kimi-k3'), qualityOf(outP, 'glm-5.3'), qualityOf(outP, 'deepseek-flash')]).toEqual([3, 3, 3]);
      // the per-answer consistency readout: K = 3 rotations of a purely positional ranking agree at τ = −1/3, never the top answer
      expect(outP.result.positionConsistency['qwen3.6-27b']).toEqual({ pairs: 6, tau: -0.3333, top1: 0 });
    }
    // a consistent judge: τ 1 and the same top answer on every pair of its ballots
    expect(out.result.positionConsistency).toEqual({ 'qwen3.6-27b': { pairs: 6, tau: 1, top1: 1 }, 'deepseek-flash': { pairs: 2, tau: 1, top1: 1 } });
  });

  it('a group no panel judge can rank is UNRANKABLE at plan time — left unjudged like a singleton (no calls, never a lost quorum, no refusal); panelWarnings predicts it from family PAIRS', async () => {
    // qwen / deepseek / kimi on q1; kimi did not answer q2 → q2 = qwen + deepseek only: each panel judge sits out its own family
    const b = bench([
      { q: 1, spec: 'qwen3.6-27b', text: 'good answer q1' }, { q: 1, spec: 'deepseek-flash', text: 'weak answer q1' }, { q: 1, spec: 'kimi-k3', text: 'best answer q1' },
      { q: 2, spec: 'qwen3.6-27b', text: 'good answer q2' }, { q: 2, spec: 'deepseek-flash', text: 'weak answer q2' },
    ]);
    const onModel = rankBy(quality);
    const out = await script.run({ argv: ['--run-id', 'mb2', '--apply'], deps: b.deps({ judgeComparativeOnModel: onModel, isTTY: false }), log: b.log });
    expect(out.exitCode).toBe(0); // was exit 1: "1 question group(s) lost quorum (… 0 ballot(s) failed …) — check the panel's routes"
    expect(out.result).toMatchObject({ comparativeGroups: 1, comparativeFailedGroups: 0, unrankableGroups: 1, unrankableAnswers: 2, ballotsFailed: 0, applied: true });
    expect(callsOf(onModel).every((c) => c.q === 'question number 1')).toBe(true); // no judge call for the unrankable group
    expect(b.lines.some((l) => /^unrankable: 1 group\(s\) \(2 answer\(s\)\) — this panel cannot give every answer 2 ballot\(s\)/.test(l))).toBe(true);
    expect(b.lines.some((l) => /group\(s\) (LOST QUORUM|lost quorum)/.test(l))).toBe(false);
    // the pre-flight names the pair (a per-spec check missed it: each spec alone can get 2 ballots)
    expect(script.panelWarnings(script.DEFAULT_JUDGE_PANEL, ['qwen3.6-27b', 'deepseek-flash', 'kimi-k3'])).toEqual([
      expect.stringMatching(/^a question only qwen3\.6-27b and deepseek-flash answered is UNRANKABLE: every panel judge shares a family with one of them/),
    ]);
    expect(b.lines.some((l) => /⚠ a question only qwen3\.6-27b and deepseek-flash answered is UNRANKABLE/.test(l))).toBe(true);
    expect(script.panelWarnings(script.DEFAULT_JUDGE_PANEL, ['glm-5.3', 'kimi-k3', 'deepseek-flash'])).toEqual([]); // the default bench

    // a two-model {qwen, deepseek} run: nothing is rankable — 0 judge calls; unattended REFUSES naming the panel (never
    // "ballots failed"); attended writes no quality with a ⚠
    const pair = () => bench([1, 2].flatMap((q) => [{ q, spec: 'qwen3.6-27b', text: `good answer q${q}` }, { q, spec: 'deepseek-flash', text: `weak answer q${q}` }]));
    const u = pair();
    const none = rankBy(quality);
    const outU = await script.run({ argv: ['--run-id', 'mb2', '--apply'], deps: u.deps({ judgeComparativeOnModel: none, isTTY: false }), log: u.log });
    expect(outU.exitCode).toBe(1);
    expect(String(outU.error)).toMatch(/no question group could be ranked \(0 comparative groups: 2 group\(s\) UNRANKABLE by this panel/);
    expect(String(outU.error)).not.toMatch(/ballot\(s\) failed|lost quorum|check the panel's routes/);
    expect(none).not.toHaveBeenCalled();
    expect(u.store.storePut).not.toHaveBeenCalled();
    const a = pair();
    const outA = await script.run({ argv: ['--run-id', 'mb2'], deps: a.deps({ judgeComparativeOnModel: rankBy(quality), isTTY: true }), log: a.log });
    expect(outA.exitCode).toBe(0);
    expect(outA.result).toMatchObject({ comparativeGroups: 0, comparativeFailedGroups: 0, unrankableGroups: 2, unrankableAnswers: 4, ballots: 0, judged: 0 });
    expect(outA.result.scorecard.models['qwen3.6-27b'].lanes.all).toMatchObject({ quality: null, qualityN: 0 });
    expect(a.lines.some((l) => /⚠ nothing ranked: 4 measured answer\(s\), 0 comparative groups — 2 group\(s\) UNRANKABLE by this panel/.test(l))).toBe(true);
  });
});
