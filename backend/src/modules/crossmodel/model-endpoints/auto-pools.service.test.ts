/**
 * Dynamic roster phase 1 — Auto pools (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B.2).
 * Empty pools follow their seats; frontier-class models never enter a pool
 * (owner 2026-10-03: open models only); a stored entry that stops resolving is
 * dropped at read time with the reason.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../middleware/error-handler', () => ({
  AppError: class AppError extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
const store: Record<string, any> = {};
jest.mock('../memory/context-store', () => ({
  storeGet: jest.fn(async (ns: string[], key: string) => store[`${ns.join(':')}/${key}`] ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { store[`${ns.join(':')}/${key}`] = value; }),
}));
const seatModels: Record<string, string> = {
  chat_quick: 'cql:api-alibaba-qwen3.8-flash',
  chat_orchestrator: 'cql:api-optimize-zai-glm-5.3-flash',
  double_checker: 'cql:api-optimize-alibaba-deepseek-v4.1-flash',
  triple_checker: 'cql:api-optimize-moonshot-kimi-k3',
};
jest.mock('./model-roles.service', () => ({ resolveRoleModel: jest.fn(async (k: string) => seatModels[k] ?? '') }));
jest.mock('./model-catalog', () => ({
  ...jest.requireActual('./model-catalog'),
  listChatModelCatalog: jest.fn(async () => CATALOG),
}));

import type { ModelCard } from './model-catalog';
import { catalogBySpec } from './model-catalog';
import {
  normalizePoolList, poolSpecRefusal, effectivePool, updateAutoPools, resolveEffectivePools, getAutoPoolsConfig,
  clearAutoPoolsCache, POOL_MAX_MODELS, POOL_SEATS, FRONTIER_POOL_REFUSAL,
} from './auto-pools.service';

const card = (spec: string, over: Partial<ModelCard> = {}): ModelCard => ({
  spec, name: spec, source: spec.includes(':') ? 'registry' : 'builtin', family: 'other', tier: 'standard', vision: false,
  contextChars: null, maxTools: null, priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...over,
});
const CATALOG: ModelCard[] = [
  card('glm-5.3'),
  card('deepseek-flash'),
  card('cql:api-alibaba-qwen3.8-flash', { family: 'qwen', tier: 'fast' }),
  card('cql:tt-qwen3.8-27b', { family: 'qwen', tier: 'fast' }),
  card('cql:api-optimize-zai-glm-5.3-flash', { family: 'glm', tier: 'fast' }),
  card('cql:api-anthropic-claude-fable-5-1', { family: 'claude', frontier: true, autoEligible: false }),
];

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  clearAutoPoolsCache();
  delete process.env.AUTO_POOLS_DISABLED;
});

describe('normalizePoolList', () => {
  it('keeps trimmed strings, drops blanks / non-strings / duplicates, caps the length', () => {
    expect(normalizePoolList([' a ', '', 'a', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(normalizePoolList(Array.from({ length: 10 }, (_, i) => `m${i}`))).toHaveLength(POOL_MAX_MODELS);
    expect(normalizePoolList('nope')).toEqual([]);
  });
});

describe('poolSpecRefusal', () => {
  const byspec = catalogBySpec(CATALOG);
  it('an open chat model qualifies', () => expect(poolSpecRefusal('cql:tt-qwen3.8-27b', byspec.get('cql:tt-qwen3.8-27b'))).toBeNull());
  it('an unknown spec is refused with a reason', () => expect(poolSpecRefusal('cql:gone', undefined)).toMatch(/not a chat model on this instance/));
  it('a frontier model is refused, the message pointing at the reflection council (owner 2026-10-06 late)', () => {
    expect(poolSpecRefusal('cql:api-anthropic-claude-fable-5-1', byspec.get('cql:api-anthropic-claude-fable-5-1'))).toBe(FRONTIER_POOL_REFUSAL);
    expect(FRONTIER_POOL_REFUSAL).toMatch(/never choose frontier.*reflection council/);
  });
  it('the hard rule: a frontier card the store\'s old all policy marked auto-eligible is STILL refused; only AUTO_PICK_FRONTIER_ENABLED=1 admits it', () => {
    const astra = card('cql:api-openai-gpt-6-astra', { family: 'gpt', frontier: true, autoEligible: true });
    expect(poolSpecRefusal('cql:api-openai-gpt-6-astra', astra, {})).toBe(FRONTIER_POOL_REFUSAL);
    // spec-only classification: a card that forgot its flag is caught by the model id
    expect(poolSpecRefusal('cql:api-xai-grok-5', card('cql:api-xai-grok-5', { autoEligible: true }), {})).toBe(FRONTIER_POOL_REFUSAL);
    expect(poolSpecRefusal('cql:api-openai-gpt-6-astra', astra, { AUTO_PICK_FRONTIER_ENABLED: '1' })).toBeNull();
  });
});

describe('effectivePool', () => {
  const byspec = catalogBySpec(CATALOG);
  it('an empty pool follows its seats (de-duplicated, unfiltered)', () => {
    expect(effectivePool('colleague', undefined, ['x', 'x', 'y'], byspec)).toEqual({ role: 'colleague', models: ['x', 'y'], source: 'seats', dropped: [] });
  });
  it('a stored pool is used in order; entries that stopped qualifying are dropped with the reason', () => {
    const p = effectivePool('quick', ['cql:tt-qwen3.8-27b', 'cql:gone', 'cql:api-alibaba-qwen3.8-flash'], ['seat'], byspec);
    expect(p.source).toBe('pool');
    expect(p.models).toEqual(['cql:tt-qwen3.8-27b', 'cql:api-alibaba-qwen3.8-flash']);
    expect(p.dropped).toEqual([{ spec: 'cql:gone', reason: expect.stringMatching(/not a chat model/) }]);
  });
  it('a pool where nothing survives falls back to the seats, keeping the drop reasons', () => {
    const p = effectivePool('lead', ['cql:api-anthropic-claude-fable-5-1'], ['seat-lead'], byspec);
    expect(p).toMatchObject({ models: ['seat-lead'], source: 'seats' });
    expect(p.dropped).toHaveLength(1);
  });
  it('disabled: the seats, whatever is stored', () => {
    expect(effectivePool('quick', ['cql:tt-qwen3.8-27b'], ['seat'], byspec, true)).toMatchObject({ models: ['seat'], source: 'seats' });
  });
});

describe('updateAutoPools / resolveEffectivePools', () => {
  it('nothing stored: every pool follows its seats (quick → Quick answers, colleague → Double + Triple Checker)', async () => {
    const pools = await resolveEffectivePools();
    expect(pools.quick).toMatchObject({ models: ['cql:api-alibaba-qwen3.8-flash'], source: 'seats' });
    expect(pools.lead.models).toEqual(['cql:api-optimize-zai-glm-5.3-flash']);
    expect(pools.checker.models).toEqual(['cql:api-optimize-alibaba-deepseek-v4.1-flash']);
    expect(pools.colleague.models).toEqual(['cql:api-optimize-alibaba-deepseek-v4.1-flash', 'cql:api-optimize-moonshot-kimi-k3']);
    expect(Object.keys(POOL_SEATS)).toEqual(['quick', 'lead', 'checker', 'colleague']);
  });

  it('saves a valid pool, stamps who, and the planner reads it back', async () => {
    const saved = await updateAutoPools({ quick: ['cql:tt-qwen3.8-27b', 'cql:api-alibaba-qwen3.8-flash'] }, 'admin-1');
    expect(saved.pools.quick).toEqual(['cql:tt-qwen3.8-27b', 'cql:api-alibaba-qwen3.8-flash']);
    expect(saved.updatedBy).toBe('admin-1');
    const pools = await resolveEffectivePools();
    expect(pools.quick).toMatchObject({ models: ['cql:tt-qwen3.8-27b', 'cql:api-alibaba-qwen3.8-flash'], source: 'pool' });
    expect(pools.lead.source).toBe('seats'); // untouched roles still follow their seats
  });

  it('refuses the WHOLE save when any spec is unknown or frontier, naming each problem; nothing is written', async () => {
    await expect(updateAutoPools({ quick: ['cql:tt-qwen3.8-27b'], lead: ['cql:api-anthropic-claude-fable-5-1', 'cql:gone'] }, 'admin-1'))
      .rejects.toThrow(/Lead — cql:api-anthropic-claude-fable-5-1: frontier-class.*Lead — cql:gone: not a chat model/);
    expect((await getAutoPoolsConfig()).pools).toEqual({});
  });

  it('the hard rule: a frontier model is refused at save even when its card says auto-eligible, and a STORED one (saved under C-1) is dropped at read time', async () => {
    const cat = [...CATALOG, card('cql:api-openai-gpt-6-astra', { family: 'gpt', frontier: true, autoEligible: true })];
    await expect(updateAutoPools({ lead: ['cql:api-openai-gpt-6-astra', 'glm-5.3'] }, 'admin-1', cat)).rejects.toThrow(/reflection council/);
    store['instance:auto-pools/config'] = { pools: { lead: ['cql:api-openai-gpt-6-astra', 'glm-5.3'] } };
    clearAutoPoolsCache();
    const lead = (await resolveEffectivePools(cat)).lead;
    expect(lead).toMatchObject({ models: ['glm-5.3'], source: 'pool' });
    expect(lead.dropped).toEqual([{ spec: 'cql:api-openai-gpt-6-astra', reason: FRONTIER_POOL_REFUSAL }]);
  });

  it('AUTO_PICK_FRONTIER_ENABLED=1 restores the C-1 admission: an auto-eligible frontier card SAVES and is read back', async () => {
    process.env.AUTO_PICK_FRONTIER_ENABLED = '1';
    try {
      const cat = [...CATALOG, card('cql:api-openai-gpt-6-astra', { family: 'gpt', frontier: true, autoEligible: true })];
      const saved = await updateAutoPools({ lead: ['cql:api-openai-gpt-6-astra', 'glm-5.3'] }, 'admin-1', cat);
      expect(saved.pools.lead).toEqual(['cql:api-openai-gpt-6-astra', 'glm-5.3']);
      expect((await resolveEffectivePools(cat)).lead).toMatchObject({ models: ['cql:api-openai-gpt-6-astra', 'glm-5.3'], source: 'pool' });
    } finally {
      delete process.env.AUTO_PICK_FRONTIER_ENABLED;
    }
  });

  it('[] or null clears a pool back to its seats; an unknown pool name is a 400', async () => {
    await updateAutoPools({ checker: ['deepseek-flash'] }, 'a');
    expect((await resolveEffectivePools()).checker.source).toBe('pool');
    await updateAutoPools({ checker: [] }, 'a');
    expect((await resolveEffectivePools()).checker.source).toBe('seats');
    await updateAutoPools({ checker: ['deepseek-flash'] }, 'a');
    await updateAutoPools({ checker: null }, 'a');
    expect((await resolveEffectivePools()).checker.source).toBe('seats');
    await expect(updateAutoPools({ wizard: ['glm-5.3'] } as any, 'a')).rejects.toThrow(/Unknown pool: wizard/);
  });

  it('more than POOL_MAX_MODELS entries is refused', async () => {
    await expect(updateAutoPools({ colleague: ['glm-5.3', 'deepseek-flash', 'cql:tt-qwen3.8-27b', 'cql:api-alibaba-qwen3.8-flash', 'cql:api-optimize-zai-glm-5.3-flash', 'x', 'y'] }, 'a'))
      .rejects.toThrow(/at most 6 models/);
  });

  it('AUTO_POOLS_DISABLED=1: every pool follows its seats even with a stored list', async () => {
    await updateAutoPools({ quick: ['cql:tt-qwen3.8-27b'] }, 'a');
    process.env.AUTO_POOLS_DISABLED = '1';
    expect((await resolveEffectivePools()).quick).toMatchObject({ models: ['cql:api-alibaba-qwen3.8-flash'], source: 'seats' });
  });
});
