/**
 * Finding C3 (2026-09-27, spark / CanLaw / canlegal-bench audit): goal_premise_set
 * merged by key and silently overwrote — spark's draft2g_tg32_mean_tps went
 * 30.88 → 18.60 on the same stack with no note naming both numbers, and a
 * judged frontier bar (73.7) sat beside a det-v2 CanLaw score (42.59) with no
 * like-for-like gap. Pins: a beyond-tolerance re-registration is a REVISION
 * (prevValue / prevManifest / revisedAt stamped, returned as revisions[] with a
 * one-line rendering); tolerance suppresses it; 'replace' mode detects it too;
 * a same-value re-registration keeps the revision record; manifest / compareTo
 * validate; the cross-project conflict check groups by key+manifest.
 *
 * Review fixes (2026-09-27): a manifest is SANITIZED like unit/note, never
 * refused (a 400 on 'suite=cal16' lost the whole goal_premise_set write); an
 * UNSET manifest is a WILDCARD in the conflict check (adding a manifest on one
 * project never switches the detector off for a legacy copy); a same-key pair
 * that differs only across manifests is never a wake.
 */
const mockPrisma: any = {
  projectGoal: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  crossModelChat: { findFirst: jest.fn(async () => null) },
  crossModelProject: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('dns', () => ({ promises: { lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) } }));

import {
  normalizePremise, normalizePremises, detectPremiseRevision, formatPremiseRevision, premiseRevisionPct, runPremiseCheckOnce,
  sanitizePremiseManifest, likeForLikeConflict, renderConflictWake, PREMISE_MANIFEST_MAX, type GoalPremise,
} from './premise-register';

const NOW = new Date('2026-09-27T14:00:00Z');
const LATER = new Date('2026-09-27T16:30:00Z');
const GOAL_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const GOAL_B = 'bbbbbbbb-0000-4000-8000-000000000000';

const existing = (): GoalPremise[] => {
  const p = normalizePremise({ key: 'draft2g_tg32_mean_tps', value: 30.88, unit: 'tok/s', manifest: 'llama-bench draft2g tg32', note: 'PR #24' }, { setByChatId: 'lane-1', now: NOW });
  if (typeof p === 'string') throw new Error(p);
  return [{ ...p, checkedAt: NOW.toISOString(), drift: 'ok' }];
};

afterEach(() => { store.clear(); jest.clearAllMocks(); });

describe('manifest + compareTo validation', () => {
  it('accepts a suite/scorer manifest and a sibling compareTo; refuses a self-pointing compareTo', () => {
    const p = normalizePremise({ key: 'canlaw_cal16_task_mean_pct', value: 42.59, unit: '%', manifest: 'canlegalbench-v0.8.0/det-v2' }, { now: NOW });
    expect(p).toMatchObject({ manifest: 'canlegalbench-v0.8.0/det-v2' });
    const bar = normalizePremise({ key: 'frontier_bar_pct', value: 73.7, unit: '%', manifest: 'judged/frontier-panel', compareTo: 'canlaw_cal16_task_mean_pct' }, { now: NOW });
    expect(bar).toMatchObject({ compareTo: 'canlaw_cal16_task_mean_pct' });
    expect(normalizePremise({ key: 'x', value: 1, compareTo: 'X' }, { now: NOW })).toMatch(/cannot point at itself/);
    expect(normalizePremise({ key: 'x', value: 1, compareTo: 'not a key!' }, { now: NOW })).toMatch(/compareTo must be the key/);
    // absent / blank manifest is simply omitted
    expect(normalizePremise({ key: 'x', value: 1, manifest: '  ' }, { now: NOW })).not.toHaveProperty('manifest');
  });
  it('review fix: a manifest is SANITIZED like unit/note, never refused — the goal_premise_set write always lands', () => {
    // the probes the review refused with a 400 before the fix
    expect(sanitizePremiseManifest('canlegalbench v0.8.0 (det-v2)')).toBe('canlegalbench v0.8.0 det-v2');
    expect(sanitizePremiseManifest('llama-bench draft2g, tg32')).toBe('llama-bench draft2g tg32');
    expect(sanitizePremiseManifest('det-v2 #3')).toBe('det-v2 3');
    expect(sanitizePremiseManifest('suite=cal16')).toBe('suite-cal16');
    expect(sanitizePremiseManifest('bad<tag>')).toBe('bad-tag');
    expect(sanitizePremiseManifest('a'.repeat(PREMISE_MANIFEST_MAX + 1))).toBe('a'.repeat(PREMISE_MANIFEST_MAX));
    expect(sanitizePremiseManifest('  Qwen3.8-27B   cpt/sft@v2+rl  ')).toBe('Qwen3.8-27B cpt/sft@v2+rl');
    // an id that is EMPTY after sanitizing is omitted, exactly like a blank one
    expect(sanitizePremiseManifest('<<<>>>')).toBe('');
    expect(sanitizePremiseManifest(null)).toBe('');
    expect(normalizePremise({ key: 'x', value: 1, manifest: '((()))' }, { now: NOW })).not.toHaveProperty('manifest');
    // the whole call lands with the sanitized ids — nothing is refused
    const r = normalizePremises([
      { key: 'k1', value: 1, manifest: 'canlegalbench v0.8.0 (det-v2)' },
      { key: 'k2', value: 2, manifest: 'a'.repeat(PREMISE_MANIFEST_MAX + 40) },
      { key: 'k3', value: 3, manifest: 'suite=cal16' },
    ], [], { now: NOW });
    if (!r.ok) throw new Error(r.error);
    expect(r.premises.map((p) => p.manifest)).toEqual(['canlegalbench v0.8.0 det-v2', 'a'.repeat(PREMISE_MANIFEST_MAX), 'suite-cal16']);
  });
});

describe('detectPremiseRevision / formatPremiseRevision', () => {
  it('names the spark regression: 30.88→18.6tok/s (-40%), same manifest ⇒ manifestMatch true', () => {
    const [prev] = existing();
    const next = normalizePremise({ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg32' }, { now: LATER }) as GoalPremise;
    const r = detectPremiseRevision(prev, next);
    expect(r).toMatchObject({ key: 'draft2g_tg32_mean_tps', old: 30.88, new: 18.6, manifestMatch: true, oldManifest: 'llama-bench draft2g tg32', newManifest: 'llama-bench draft2g tg32' });
    expect(Math.round(r!.pct!)).toBe(-40);
    expect(r!.line).toBe('premise draft2g_tg32_mean_tps revised 30.88→18.6tok/s (-40%)');
  });
  it('a manifest change on the move is named as not like-for-like; no prior ⇒ no revision; within tolerance ⇒ no revision', () => {
    const [prev] = existing();
    const other = normalizePremise({ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg64' }, { now: LATER }) as GoalPremise;
    const r = detectPremiseRevision(prev, other)!;
    expect(r.manifestMatch).toBe(false);
    expect(r.line).toBe('premise draft2g_tg32_mean_tps revised 30.88→18.6tok/s (-40%) — manifest llama-bench draft2g tg32→llama-bench draft2g tg64, not like-for-like');
    expect(detectPremiseRevision(undefined, other)).toBeNull();
    const nudge = normalizePremise({ key: 'draft2g_tg32_mean_tps', value: 30.5, tolerance: 0.5 }, { now: LATER }) as GoalPremise;
    expect(detectPremiseRevision(prev, nudge)).toBeNull();
    // the LARGER tolerance of either side governs
    expect(detectPremiseRevision({ ...prev, tolerance: 1 }, { ...nudge, tolerance: 0 })).toBeNull();
    expect(detectPremiseRevision({ ...prev, tolerance: 0.1 }, { ...nudge, tolerance: 0 })).not.toBeNull();
  });
  it('percent formatting: from 0 has no percent, small moves keep one decimal, big moves round', () => {
    expect(premiseRevisionPct(0, 5)).toBeNull();
    expect(formatPremiseRevision({ key: 'k', old: 0, new: 5, pct: null, manifestMatch: null })).toBe('premise k revised 0→5 (from 0)');
    expect(formatPremiseRevision({ key: 'k', old: 100, new: 102.5, pct: 2.5, manifestMatch: null })).toBe('premise k revised 100→102.5 (+2.5%)');
    expect(formatPremiseRevision({ key: 'k', old: 60.07, new: 42.59, pct: premiseRevisionPct(60.07, 42.59), unit: '%', manifestMatch: null, newManifest: 'det-v2' })).toBe('premise k revised 60.07→42.59% (-29%) [det-v2]');
  });
});

describe('normalizePremises — revisions on merge and replace', () => {
  it('merge: a beyond-tolerance re-registration stamps prevValue/prevManifest/revisedAt and returns revisions[]', () => {
    const r = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg32', note: 'rerun 2026-09-27' }], existing(), { setByChatId: 'lane-2', now: LATER });
    if (!r.ok) throw new Error(r.error);
    expect(r.revisions).toHaveLength(1);
    expect(r.revisions[0].line).toBe('premise draft2g_tg32_mean_tps revised 30.88→18.6tok/s (-40%)');
    const p = r.premises.find((x) => x.key === 'draft2g_tg32_mean_tps')!;
    expect(p).toMatchObject({ value: 18.6, prevValue: 30.88, prevManifest: 'llama-bench draft2g tg32', revisedAt: LATER.toISOString(), setByChatId: 'lane-2' });
    // the old check stamps do NOT carry over (the value changed — they described the old number)
    expect(p.drift).toBeUndefined();
  });
  it('replace: rewriting the set with a moved value is a revision too (the silent-overwrite shape C3 names)', () => {
    const r = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s' }, { key: 'other', value: 1 }], existing(), { mode: 'replace', now: LATER });
    if (!r.ok) throw new Error(r.error);
    expect(r.revisions.map((x) => x.key)).toEqual(['draft2g_tg32_mean_tps']);
    expect(r.premises).toHaveLength(2);
    expect(r.premises[0]).toMatchObject({ prevValue: 30.88, prevManifest: 'llama-bench draft2g tg32' });
  });
  it('re-registering the SAME value keeps the revision record (the board keeps naming it for its window); a within-tolerance nudge keeps it too', () => {
    const first = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg32' }], existing(), { now: LATER });
    if (!first.ok) throw new Error(first.error);
    const again = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg32' }], first.premises, { now: new Date(LATER.getTime() + 60_000) });
    if (!again.ok) throw new Error(again.error);
    expect(again.revisions).toEqual([]);
    expect(again.premises[0]).toMatchObject({ prevValue: 30.88, revisedAt: LATER.toISOString() });
    const nudge = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 18.7, unit: 'tok/s', tolerance: 0.5 }], first.premises, { now: new Date(LATER.getTime() + 120_000) });
    if (!nudge.ok) throw new Error(nudge.error);
    expect(nudge.revisions).toEqual([]);
    expect(nudge.premises[0]).toMatchObject({ value: 18.7, prevValue: 30.88, revisedAt: LATER.toISOString() });
  });
  it('a NEW key is never a revision; an unchanged premise keeps its check stamps as before', () => {
    const r = normalizePremises([{ key: 'draft2g_tg32_mean_tps', value: 30.88, unit: 'tok/s', manifest: 'llama-bench draft2g tg32' }, { key: 'new_key', value: 7 }], existing(), { now: LATER });
    if (!r.ok) throw new Error(r.error);
    expect(r.revisions).toEqual([]);
    expect(r.premises[0]).toMatchObject({ checkedAt: NOW.toISOString(), drift: 'ok' });
    expect(r.premises[1]).not.toHaveProperty('prevValue');
  });
});

describe('cross-project conflict check groups by key + manifest', () => {
  const rows = (manifestB: string | undefined) => [
    { id: GOAL_A, userId: 'u1', projectId: 'p-canlaw', title: 'CanLaw', status: 'active', updatedAt: NOW, premises: [{ key: 'suite_mean', value: 42.59, unit: '%', manifest: 'canlegalbench-v0.8.0/det-v2' }], project: { name: 'CanLaw' } },
    { id: GOAL_B, userId: 'u1', projectId: 'p-bench', title: 'Bench', status: 'active', updatedAt: NOW, premises: [{ key: 'suite_mean', value: 73.7, unit: '%', ...(manifestB ? { manifest: manifestB } : {}) }], project: { name: 'canlegal-bench' } },
  ];
  it('different manifests ⇒ not like-for-like ⇒ no [PREMISE CONFLICT] wake; same manifest ⇒ the wake fires as before', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'fleet-sup' });
    mockPrisma.projectGoal.findMany.mockResolvedValue(rows('judged/frontier-panel'));
    const wake = jest.fn(async () => ({}));
    const a = await runPremiseCheckOnce({ enqueueDirectWake: wake, now: NOW });
    expect(a.conflicts).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    // …and a later pass over the same rows still never wakes
    await runPremiseCheckOnce({ enqueueDirectWake: wake, now: LATER });
    expect(wake).not.toHaveBeenCalled();
    mockPrisma.projectGoal.findMany.mockResolvedValue(rows('canlegalbench-v0.8.0/det-v2'));
    const b = await runPremiseCheckOnce({ enqueueDirectWake: wake, now: NOW });
    expect(b.conflicts).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((wake.mock.calls[0] as any)[0].prompt).toContain('[PREMISE CONFLICT]');
  });
  it('review fix: an UNSET manifest is a WILDCARD — a legacy manifest-less copy still conflicts with a manifested one (the wake names both)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'fleet-sup' });
    mockPrisma.projectGoal.findMany.mockResolvedValue(rows(undefined));
    const wake = jest.fn(async () => ({}));
    const a = await runPremiseCheckOnce({ enqueueDirectWake: wake, now: NOW });
    expect(a.conflicts).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    const prompt = (wake.mock.calls[0] as any)[0].prompt as string;
    expect(prompt).toContain('CanLaw goal aaaaaaaa "CanLaw" says 42.59% [canlegalbench-v0.8.0/det-v2]');
    expect(prompt).toContain('canlegal-bench goal bbbbbbbb "Bench" says 73.7% [no manifest]');
  });
  it('likeForLikeConflict (pure): buckets by manifest with unset as wildcard; a wildcard copy joins only the bucket it disagrees with', () => {
    const e = (projectId: string, value: number, manifest?: string, tolerance?: number) => ({ g: { projectId }, p: { key: 'k', value, ...(manifest ? { manifest } : {}), ...(tolerance !== undefined ? { tolerance } : {}) } as GoalPremise });
    // det-v2 42 (±0.5) · judged 73 · a manifest-less 42.1: the wildcard copy sits in BOTH buckets —
    // it agrees with det-v2 (within tolerance) and contradicts the judged bar ⇒ only [judged, wildcard] wake;
    // det-v2 vs judged is not like-for-like and never conflicts.
    const a = e('p1', 42, 'det-v2', 0.5); const b = e('p2', 73, 'judged'); const c = e('p3', 42.1);
    expect(likeForLikeConflict([a, b, c])).toEqual({ conflicting: [b, c], notLikeForLike: false });
    // only different manifests ⇒ no conflict, flagged not-like-for-like
    expect(likeForLikeConflict([a, b])).toEqual({ conflicting: [], notLikeForLike: true });
    // no manifests anywhere ⇒ the pre-C3 key-only rule
    expect(likeForLikeConflict([e('p1', 1), e('p2', 2)])).toEqual({ conflicting: [e('p1', 1), e('p2', 2)], notLikeForLike: false });
    // one project, or equal values ⇒ nothing
    expect(likeForLikeConflict([e('p1', 1, 'm'), e('p1', 2, 'm')])).toEqual({ conflicting: [], notLikeForLike: false });
    expect(likeForLikeConflict([e('p1', 1, 'm'), e('p2', 1, 'm')])).toEqual({ conflicting: [], notLikeForLike: false });
  });
  it('renderConflictWake tags each value with its manifest, and a manifest-less copy as [no manifest] only when a sibling has one', () => {
    const tagged = renderConflictWake('k', [{ id: GOAL_A, title: 'A', projectName: 'PA', p: { key: 'k', value: 1, manifest: 'det-v2' } }, { id: GOAL_B, title: 'B', projectName: 'PB', p: { key: 'k', value: 2 } }]);
    expect(tagged).toContain('PA goal aaaaaaaa "A" says 1 [det-v2]; PB goal bbbbbbbb "B" says 2 [no manifest]');
    const plain = renderConflictWake('k', [{ id: GOAL_A, title: 'A', projectName: 'PA', p: { key: 'k', value: 1 } }, { id: GOAL_B, title: 'B', projectName: 'PB', p: { key: 'k', value: 2 } }]);
    expect(plain).toContain('PA goal aaaaaaaa "A" says 1; PB goal bbbbbbbb "B" says 2');
  });
});
