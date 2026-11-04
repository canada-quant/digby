/**
 * Nightly memory dream — over-removal guard + durable audit (2026-09-21).
 *
 * Owner report: the Memory tab showed 3 facts; a live replay of the extractor
 * on his own message produced adds in one second; the 09-15 rebuild had made
 * 16 facts. Nothing recorded who removed what — the dream logged at INFO
 * (lost on every deploy) and its bookkeeping remembers one run. Pins:
 *  - a consolidation that drops more than MAX_DREAM_DROP_RATIO (min 1) of the
 *    facts is REJECTED and the originals kept (the old 25 %-kept rule let
 *    16 → 4 through, then 4 → 3);
 *  - a modest consolidation is accepted and every removed key is audited;
 *  - other internal `__` keys (the rebuild status) survive the dream's save.
 *
 * 2026-10-20: the consolidation answers per-item OPS by default; the original
 * whole-object pins run under MEMORY_STATE_OPS_DISABLED=1 (the kill switch
 * restores that path byte-for-byte) and the same guards are pinned on the ops
 * shape below.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFindMany: jest.Mock = jest.fn();
const mockUpdate: jest.Mock = jest.fn(async () => ({}));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: {
      findMany: (...a: any[]) => mockFindMany(...a),
      // the all-active-users tick re-reads each user right before dreaming (2026-10-20)
      findUnique: async ({ where }: any) => ((await mockFindMany()) as any[]).find((r) => r.userId === where.userId) ?? null,
      update: (...a: any[]) => mockUpdate(...a),
    },
  },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK') } }));
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
jest.mock('./memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn() }));
jest.mock('./langgraph/memory.graph', () => ({
  buildRejectionKeywords: () => new Set<string>(),
  scrubUserContextState: (s: any) => s,
}));
jest.mock('./coding/coding-memory.service', () => ({ dreamCodingProjects: jest.fn(async () => 0) }));
jest.mock('./memory-relevance', () => ({
  topicalTokens: (t: string) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
}));
const mockRecordMemoryMutation: jest.Mock = jest.fn();
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
jest.mock('./memory/memory-audit', () => ({
  recordMemoryMutation: (...a: any[]) => mockRecordMemoryMutation(...a),
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  extractionDetailOf: (raw: unknown) => String(raw ?? '').slice(0, 200),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import { runDreamCycle } from './memory-maintenance.service';

const SIX = {
  name: 'Paul', location: 'Oak Bay, Canada', role: 'Head of AI Cloud', timezone: 'America/Vancouver',
  annual_family_trip: 'Four Seasons Lanai every year', music: 'late 90s emo and punk',
};
const row = (facts: Record<string, unknown>) => ({
  userId: 'u1', facts, updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // past the 30-min quiet period
});
const savedFacts = () => mockUpdate.mock.calls[0][0].data.facts as Record<string, any>;

beforeEach(() => { jest.clearAllMocks(); });
afterAll(() => { delete process.env.MEMORY_STATE_OPS_DISABLED; });

describe('dream over-removal guard — whole-object path (MEMORY_STATE_OPS_DISABLED=1)', () => {
  beforeEach(() => { process.env.MEMORY_STATE_OPS_DISABLED = '1'; });
  afterEach(() => { delete process.env.MEMORY_STATE_OPS_DISABLED; });

  it('asks for the whole object at the old 900-token budget', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ facts: SIX, removed: [] }));
    await runDreamCycle(true);
    expect(String(mockUtilityChat.mock.calls[0][0][0].content)).toContain('{"facts": {"key": "value", ...}, "removed": [');
    expect(mockUtilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ maxTokens: 900 }));
    expect(mockRecordExtractionOutcome).not.toHaveBeenCalled();
  });

  it('rejects a consolidation that drops more than a third of the facts — originals kept, audited as rejected', async () => {
    mockFindMany.mockResolvedValue([row({ ...SIX, __rebuild: { total: 9, processed: 9 } })]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      facts: { name: 'Paul', location: 'Oak Bay, Canada', timezone: 'America/Vancouver' },
      removed: [{ key: 'role', reason: 'project-specific' }, { key: 'annual_family_trip', reason: 'stale' }, { key: 'music', reason: 'non-fact' }],
    }));
    await runDreamCycle(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const facts = savedFacts();
    for (const k of Object.keys(SIX)) expect(facts[k]).toBe((SIX as any)[k]);
    expect(facts.__dream.lastRemovedCount).toBe(0);
    expect(facts.__rebuild).toEqual({ total: 9, processed: 9 }); // internal bookkeeping survives
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      source: 'dream', before: 6, after: 6, removed: [], rejectedConsolidation: expect.stringContaining('kept only 3/6'),
    }));
  });

  it('accepts a modest consolidation (≤ a third) and audits the removed keys', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    const { music, ...five } = SIX;
    void music;
    mockUtilityChat.mockResolvedValue(JSON.stringify({ facts: five, removed: [{ key: 'music', reason: 'non-fact' }] }));
    await runDreamCycle(true);
    const facts = savedFacts();
    expect(facts.music).toBeUndefined();
    expect(facts.name).toBe('Paul');
    expect(facts.__dream.lastRemovedCount).toBe(1);
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', before: 6, after: 5, removed: ['music'] }));
    expect(mockRecordMemoryMutation.mock.calls[0][0].rejectedConsolidation).toBeUndefined();
  });

  it('a tiny memory may lose at most ONE fact per night', async () => {
    mockFindMany.mockResolvedValue([row({ name: 'Paul', location: 'Oak Bay', role: 'Head of AI Cloud' })]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ facts: { name: 'Paul' }, removed: [{ key: 'location', reason: 'stale' }, { key: 'role', reason: 'project-specific' }] }));
    await runDreamCycle(true);
    const facts = savedFacts();
    expect(facts.location).toBe('Oak Bay');
    expect(facts.role).toBe('Head of AI Cloud');
  });

  it('an unchanged memory records no mutation', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ facts: SIX, removed: [] }));
    await runDreamCycle(true);
    expect(mockRecordMemoryMutation).not.toHaveBeenCalled();
  });
});

describe('dream guards — per-item ops path (default)', () => {
  it('asks for the changes only, at the ops budget', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue('{}');
    await runDreamCycle(true);
    const prompt = String(mockUtilityChat.mock.calls[0][0][0].content);
    expect(prompt).toContain('{"merge": [{"keys": [');
    expect(prompt).not.toContain('{"facts": {"key": "value"');
    expect(mockUtilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ maxTokens: 1500 }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'noop', budgetTokens: 1500 }));
    expect(mockRecordMemoryMutation).not.toHaveBeenCalled(); // {} = nothing to clean
  });

  it('rejects ops that drop more than a third of the facts — originals kept, audited as rejected', async () => {
    mockFindMany.mockResolvedValue([row({ ...SIX, __rebuild: { total: 9, processed: 9 } })]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      remove: [{ key: 'role', reason: 'project-specific' }, { key: 'annual_family_trip', reason: 'stale' }, { key: 'music', reason: 'non-fact' }],
    }));
    await runDreamCycle(true);
    const facts = savedFacts();
    for (const k of Object.keys(SIX)) expect(facts[k]).toBe((SIX as any)[k]);
    expect(facts.__dream.lastRemovedCount).toBe(0);
    expect(facts.__rebuild).toEqual({ total: 9, processed: 9 });
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      source: 'dream', before: 6, after: 6, removed: [], rejectedConsolidation: expect.stringContaining('kept only 3/6'),
    }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'noop', detail: expect.stringContaining('guard rejected') }));
  });

  it('a merge counts every merged-away key toward the max-drop guard', async () => {
    mockFindMany.mockResolvedValue([row({ name: 'Paul', location: 'Oak Bay', lives_in: 'Oak Bay, Canada', city: 'Oak Bay' })]);
    // 4 facts → max drop 1; merging 3 keys into one drops 2
    mockUtilityChat.mockResolvedValue(JSON.stringify({ merge: [{ keys: ['location', 'lives_in', 'city'], into: 'location', value: 'Oak Bay, Canada' }] }));
    await runDreamCycle(true);
    expect(savedFacts().city).toBe('Oak Bay');
    expect(mockRecordMemoryMutation.mock.calls[0][0].rejectedConsolidation).toContain('kept only 2/4');
  });

  it('accepts a modest merge (≤ a third) and audits the merged-away key', async () => {
    mockFindMany.mockResolvedValue([row({ ...SIX, lives_in: 'Oak Bay' })]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ merge: [{ keys: ['location', 'lives_in'], into: 'location', value: 'Oak Bay, Canada' }] }));
    await runDreamCycle(true);
    const facts = savedFacts();
    expect(facts.lives_in).toBeUndefined();
    expect(facts.location).toBe('Oak Bay, Canada');
    expect(facts.__dream.lastRemovedCount).toBe(1);
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', before: 7, after: 6, removed: ['lives_in'] }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'changed' }));
  });

  it('rejects an update that invents content (Guard B, per item)', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({ update: { music: 'classical opera devotee attending Salzburg festivals' } }));
    await runDreamCycle(true);
    expect(savedFacts().music).toBe(SIX.music);
    expect(mockRecordMemoryMutation.mock.calls[0][0].rejectedConsolidation).toBe('novel content in "music"'); // key only, never the value
  });

  it('unknown keys, internal keys and parroted placeholders are ignored', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      merge: [{ keys: ['<key_a>', '<key_b>'], into: '<key_a>', value: '<merged value>' }],
      update: { nope: 'x', __dream: 'y', name: '<normalized value>' },
      remove: [{ key: 'not_a_key', reason: 'stale' }, { key: '__rejections', reason: 'banned' }],
    }));
    await runDreamCycle(true);
    const facts = savedFacts();
    for (const k of Object.keys(SIX)) expect(facts[k]).toBe((SIX as any)[k]);
    expect(Object.keys(facts).filter((k) => !k.startsWith('__')).sort()).toEqual(Object.keys(SIX).sort());
    expect(mockRecordMemoryMutation).not.toHaveBeenCalled();
  });

  it('a non-JSON answer is a parse_error outcome, never a silent debug line — originals kept', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockResolvedValue('I think these facts look fine overall.');
    await runDreamCycle(true);
    expect(savedFacts().name).toBe('Paul');
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'parse_error', detail: expect.stringContaining('look fine') }));
  });

  it('a failing utility call is an llm_error outcome', async () => {
    mockFindMany.mockResolvedValue([row(SIX)]);
    mockUtilityChat.mockRejectedValue(new Error('HTTP 429 rate limited'));
    await runDreamCycle(true);
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'llm_error', detail: expect.stringContaining('429') }));
    expect(savedFacts().name).toBe('Paul');
  });
});
