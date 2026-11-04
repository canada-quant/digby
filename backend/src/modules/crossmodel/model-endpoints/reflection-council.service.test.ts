/**
 * F2 — the reflection council's frontier list (owner 2026-10-06 late): the servable frontier-class models an agent may
 * choose (provider-diversity order, prices) and the admin-editable default the harness auto-run uses.
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

import type { ModelCard } from './model-catalog';
import {
  frontierCouncilModels, orderByProviderDiversity, resolveCouncilFrom, resolveReflectionCouncil, updateReflectionCouncil,
  getReflectionCouncilConfig, clearReflectionCouncilCache, councilSpecRefusal, REFLECTION_COUNCIL_MAX,
} from './reflection-council.service';

const card = (spec: string, over: Partial<ModelCard> = {}): ModelCard => ({
  spec, name: spec, source: 'registry', family: 'other', tier: 'standard', vision: false, contextChars: null, maxTools: null,
  priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...over,
});
const CATALOG: ModelCard[] = [
  card('glm-5.3', { source: 'builtin', family: 'glm' }),
  card('cql:api-anthropic-claude-haiku-5', { family: 'claude', tier: 'fast', frontier: true, autoEligible: false }),
  card('cql:api-anthropic-claude-fable-5-1', { family: 'claude', tier: 'strong', frontier: true, autoEligible: false, priceIn: 15, priceOut: 75 }),
  card('cql:api-openai-gpt-6-astra', { family: 'gpt', tier: 'strong', frontier: true, autoEligible: false, priceIn: 1.25, priceOut: 10 }),
  card('cql:api-openai-gpt-6-luna', { family: 'gpt', tier: 'fast', frontier: true, autoEligible: false }),
  card('cql:api-xai-grok-5', { family: 'grok', frontier: true, autoEligible: false }),
  card('cql:api-optimize-zai-glm-5.3', { family: 'glm' }),
  card('cql:gone-frontier', { family: 'gemini', frontier: true, servable: false }),
];

beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; clearReflectionCouncilCache(); });

describe('the frontier list', () => {
  it('only servable frontier-class chat models, ordered by provider diversity (round-robin across vendors, strongest first)', () => {
    const list = orderByProviderDiversity(frontierCouncilModels(CATALOG)).map((m) => m.spec);
    expect(list).toEqual([
      'cql:api-anthropic-claude-fable-5-1', 'cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5',
      'cql:api-anthropic-claude-haiku-5', 'cql:api-openai-gpt-6-luna',
    ]);
    expect(frontierCouncilModels(CATALOG).find((m) => m.spec === 'cql:api-openai-gpt-6-astra')).toMatchObject({ priceIn: 1.25, priceOut: 10 });
  });
  it('unset ⇒ the first 3 of the diversity order (three vendors); an admin list wins; stale entries are dropped with the reason', () => {
    expect(resolveCouncilFrom({ models: [] }, CATALOG)).toMatchObject({
      source: 'diversity', defaults: ['cql:api-anthropic-claude-fable-5-1', 'cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5'],
    });
    const r = resolveCouncilFrom({ models: ['cql:api-xai-grok-5', 'glm-5.3', 'cql:gone-frontier'] }, CATALOG);
    expect(r).toMatchObject({ source: 'admin', defaults: ['cql:api-xai-grok-5'] });
    expect(r.dropped.map((d) => d.spec)).toEqual(['glm-5.3', 'cql:gone-frontier']);
    expect(r.dropped[0].reason).toMatch(/not a frontier-class model/);
    expect(councilSpecRefusal('x', undefined)).toMatch(/not a chat model/);
  });
  it('an instance with no frontier model: no candidates, no defaults', () => {
    expect(resolveCouncilFrom({ models: [] }, [card('glm-5.3')])).toMatchObject({ candidates: [], defaults: [] });
  });
});

describe('the admin list (store-backed, 1–3 frontier models)', () => {
  it('saves a valid list, stamps who, and the harness reads it back', async () => {
    const saved = await updateReflectionCouncil(['cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5'], 'admin-1', CATALOG);
    expect(saved).toMatchObject({ models: ['cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5'], updatedBy: 'admin-1' });
    expect(store['instance:model-roles/reflection-council'].models).toEqual(['cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5']);
    expect((await resolveReflectionCouncil(CATALOG)).defaults).toEqual(['cql:api-openai-gpt-6-astra', 'cql:api-xai-grok-5']);
  });
  it('refuses an open model or an unknown spec (the whole save), and more than 3 models', async () => {
    await expect(updateReflectionCouncil(['cql:api-xai-grok-5', 'glm-5.3'], 'a', CATALOG)).rejects.toThrow(/glm-5\.3: not a frontier-class model/);
    await expect(updateReflectionCouncil(['cql:nope'], 'a', CATALOG)).rejects.toThrow(/cql:nope: not a chat model/);
    await expect(updateReflectionCouncil(['a', 'b', 'c', 'd'], 'a', CATALOG)).rejects.toThrow(new RegExp(`at most ${REFLECTION_COUNCIL_MAX}`));
    await expect(updateReflectionCouncil('nope' as any, 'a', CATALOG)).rejects.toThrow(/expected/);
    expect(store['instance:model-roles/reflection-council']).toBeUndefined();
  });
  it('[] / null clears back to the diversity default', async () => {
    await updateReflectionCouncil(['cql:api-xai-grok-5'], 'a', CATALOG);
    await updateReflectionCouncil([], 'a', CATALOG);
    expect((await getReflectionCouncilConfig()).models).toEqual([]);
    expect((await resolveReflectionCouncil(CATALOG)).source).toBe('diversity');
    await updateReflectionCouncil(null, 'a', CATALOG);
    expect((await getReflectionCouncilConfig()).models).toEqual([]);
  });
});
