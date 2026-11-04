/**
 * Dynamic roster phase 1 — the model catalog's pure card rules
 * (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5). The ids below are the real
 * registry ids on the prod gateway (llm.example.com, DR1003 readout 2026-10-03).
 */
jest.mock('../coding/coding-model', () => ({
  BUILT_IN_CODING_MODEL_IDS: ['glm-5.3', 'deepseek-flash'],
  registryContextChars: (t: number) => Math.round(t * 2),
  resolveProvider: (id: string) => ({ supportsVision: id === 'deepseek-flash', contextChars: 4_000_000, envKey: id === 'glm-5.3' ? 'ZAI_API_KEY' : 'DEEPSEEK_API_KEY' }),
}));
// roster 2026-10-06 C-1: listChatModelCatalog reads the store-backed auto-pick policy.
const mockAutoPickPolicy = jest.fn(async () => 'all');
jest.mock('../platform/roster-policy', () => ({ __esModule: true, DEFAULT_AUTO_PICK_POLICY: 'all', autoPickPolicy: () => mockAutoPickPolicy() }));
jest.mock('./model-endpoints.service', () => ({
  __esModule: true,
  isChatCapableEntry: () => true,
  listEndpoints: async () => [{ label: 'cql', enabled: true, settings: {}, providerClass: 'open', frontierModelIds: ['api-anthropic-claude-fable-5-1'], models: [{ id: 'api-anthropic-claude-fable-5-1' }, { id: 'tt-qwen3.8-27b' }] }],
}));
import { builtInTwinOf, listChatModelCatalog, modelFamily, modelTier, modelIdOf, builtInCard, registryCard, catalogBySpec } from './model-catalog';

describe('modelIdOf', () => {
  it('strips the endpoint label from a registry spec; a built-in id passes through', () => {
    expect(modelIdOf('cql-litellm:api-alibaba-qwen3.8-flash')).toBe('api-alibaba-qwen3.8-flash');
    expect(modelIdOf('glm-5.3')).toBe('glm-5.3');
  });
});

describe('modelFamily — the MODEL line, never the hosting vendor or the endpoint label', () => {
  it.each([
    ['glm-5.3', 'glm'],
    ['cql-litellm:api-optimize-zai-glm-5.3-flash', 'glm'],
    ['cql-litellm:spark-glm-5.3-flash', 'glm'],
    ['kimi-k3', 'kimi'],
    ['cql-litellm:api-optimize-moonshot-kimi-k3', 'kimi'],
    ['cql-litellm:api-optimize-moonshot-kimi-for-coding', 'kimi'],
    ['deepseek-flash', 'deepseek'],
    // an Alibaba-hosted DeepSeek is still DeepSeek (checker diversity must see that)
    ['cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash', 'deepseek'],
    ['cql-litellm:api-fireworks-deepseek-v4-pro', 'deepseek'],
    ['qwen3.6-27b', 'qwen'],
    ['cql-litellm:api-alibaba-qwen3.8-flash', 'qwen'],
    ['cql-litellm:tt-qwen3.8-27b', 'qwen'],
    ['cql-litellm:spark-qwen3.8-flash-next', 'qwen'],
    ['cql-litellm:mimo-v26-flash-rl', 'mimo'],
    ['cql-litellm:api-anthropic-claude-fable-5-1', 'claude'],
    ['cql-litellm:api-openai-gpt-5.6-sol', 'gpt'],
    ['cql-litellm:api-xai-grok-4.6', 'grok'],
    ['cql-litellm:api-cohere-command-a-plus', 'cohere'],
    ['ollama:mystery-model', 'other'],
  ])('%s → %s', (spec, fam) => {
    expect(modelFamily(spec)).toBe(fam);
  });
});

describe('modelTier', () => {
  it.each([
    ['glm-5.3-flash', 'fast'],
    ['qwen3.6-flash', 'fast'],
    ['qwen3.6-27b', 'fast'],
    ['cql-litellm:tt-qwen3.8-27b', 'fast'],
    ['cql-litellm:spark-qwen3-4b-helper', 'fast'],
    ['cql-litellm:api-openai-gpt-5.6-luna', 'fast'],
    ['glm-5.3', 'standard'],
    ['kimi-k3', 'standard'],
    ['cql-litellm:api-alibaba-qwen3.8-max', 'strong'],
    ['cql-litellm:api-deepseek-v4-pro', 'strong'],
    ['cql-litellm:api-anthropic-claude-opus-5', 'strong'],
  ])('%s → %s', (spec, tier) => {
    expect(modelTier(spec)).toBe(tier);
  });
});

describe('builtInCard', () => {
  it('prices from the cost table, never frontier, servable only with its provider key', () => {
    const c = builtInCard('deepseek-flash', { supportsVision: true, contextChars: 4_000_000, envKey: 'DEEPSEEK_API_KEY' }, { DEEPSEEK_API_KEY: 'k' } as any);
    expect(c).toMatchObject({ spec: 'deepseek-flash', source: 'builtin', family: 'deepseek', tier: 'fast', vision: true, contextChars: 4_000_000, priceIn: 0.15, priceOut: 0.6, frontier: false, autoEligible: true, servable: true });
    expect(builtInCard('deepseek-flash', { supportsVision: true, envKey: 'DEEPSEEK_API_KEY' } as any, {} as any).servable).toBe(false);
  });
  it('a built-in with no price on record says so (null), never a made-up number', () => {
    const c = builtInCard('some-future-builtin', { supportsVision: true, envKey: 'ZAI_API_KEY' } as any, { ZAI_API_KEY: 'k' } as any);
    expect(c.priceIn).toBeNull();
    expect(c.priceOut).toBeNull();
  });
  it('glm-5.3-flash prices from the Z.ai list (build 2026-10-08 Q-1 — was unpriced)', () => {
    const c = builtInCard('glm-5.3-flash', { supportsVision: true, envKey: 'ZAI_API_KEY' } as any, { ZAI_API_KEY: 'k' } as any);
    expect(c).toMatchObject({ priceIn: 0.15, priceOut: 0.5, priceSource: 'builtin' });
  });
});

describe('registryCard', () => {
  const ep = { label: 'cql-litellm', settings: { maxTools: 64 }, frontierModelIds: ['api-anthropic-claude-fable-5-1'], providerClass: 'open' as const };
  it('an open gateway model is auto-eligible; endpoint settings fill a missing tool cap', () => {
    const c = registryCard(ep as any, { id: 'api-alibaba-qwen3.8-flash', vision: true, coding: true } as any);
    expect(c).toMatchObject({ spec: 'cql-litellm:api-alibaba-qwen3.8-flash', family: 'qwen', tier: 'fast', vision: true, maxTools: 64, frontier: false, autoEligible: true, servable: true });
  });
  // Gateway swap 2026-10-24 (catalog refresh): MiniMax-M3.1-Flash replaced the dead-named
  // deepseek-v4.1-flash routes on llm.example.com — served as `minimax-m3.1-flash` plus the bare
  // alias `m3.1-flash`, both e2e-verified 200 with /model/info max_input_tokens 262144. The
  // bare alias has no vendor stem, so the FAMILY_RULES m-flash shape must name the line.
  it('the 2026-10-24 MiniMax swap: both served ids family minimax, tier fast, ctx from the entry', () => {
    for (const id of ['minimax-m3.1-flash', 'm3.1-flash']) {
      const c = registryCard(ep as any, { id, contextWindow: 262144 } as any);
      expect(c).toMatchObject({ spec: `cql-litellm:${id}`, source: 'registry', family: 'minimax', tier: 'fast', frontier: false, autoEligible: true, servable: true });
      expect(c.contextChars).toBe(524288); // registryContextChars(262144) = 262144×2
    }
  });
  it('the m-flash family shape does not capture other vendors\' ids (regression pin)', () => {
    for (const [id, fam] of [['mimo-v26-flash-rl', 'mimo'], ['qwen3.6-flash', 'qwen'], ['kimi-k3', 'kimi'], ['glm-5.3', 'glm'], ['api-anthropic-claude-fable-5-1', 'claude']] as const) {
      expect(registryCard(ep as any, { id } as any).family).toBe(fam);
    }
  });
  // 2026-10-06 retired entries (f90 follow-up): the card stays LISTED (the admin sees it) but is
  // never a candidate — servable:false, the same shape a keyless built-in has, so turn-plan /
  // model-pick / call-in all filter it out. This is what retires api-cohere-command-a-plus.
  it('a retired (unservable) entry lists with servable:false — never a candidate', () => {
    const c = registryCard(ep as any, { id: 'api-cohere-command-a-plus', unservable: true } as any);
    expect(c).toMatchObject({ spec: 'cql-litellm:api-cohere-command-a-plus', source: 'registry', family: 'cohere', servable: false });
    expect(c.autoEligible).toBe(true); // the POLICY class is untouched — only servability reads the flag
    // Unretired control: the identical entry without the flag stays servable.
    expect(registryCard(ep as any, { id: 'api-cohere-command-a-plus' } as any).servable).toBe(true);
  });
  it('auto-pick policy open_only (the 2026-10-03 rule): a frontier id behind the proxy is badged frontier and NEVER auto-eligible', () => {
    const c = registryCard(ep as any, { id: 'api-anthropic-claude-fable-5-1', vision: true } as any, undefined, { autoPickPolicy: 'open_only' });
    expect(c.frontier).toBe(true);
    expect(c.autoEligible).toBe(false);
  });
  it('auto-pick policy open_only: a frontier vendor HOST makes every model on it frontier and ineligible', () => {
    const c = registryCard({ ...ep, providerClass: 'frontier', frontierModelIds: [] } as any, { id: 'whatever' } as any, undefined, { autoPickPolicy: 'open_only' });
    expect(c.frontier).toBe(true);
    expect(c.autoEligible).toBe(false);
  });
  it('auto-pick policy all (roster 2026-10-06 C-1, the default — owner: "any and all models"): a frontier card stays badged frontier AND is auto-eligible', () => {
    const c = registryCard(ep as any, { id: 'api-anthropic-claude-fable-5-1', vision: true } as any, undefined, { autoPickPolicy: 'all' });
    expect(c).toMatchObject({ frontier: true, autoEligible: true });
    expect(registryCard(ep as any, { id: 'api-anthropic-claude-fable-5-1' } as any).autoEligible).toBe(true); // default policy = all
    expect(registryCard({ ...ep, providerClass: 'frontier', frontierModelIds: [] } as any, { id: 'gpt-6-astra' } as any, undefined, { autoPickPolicy: 'all' }).autoEligible).toBe(true);
  });
  it('a frontier model with no price on record stays unpriced (the pick then charges its conservative frontier default) — never a twin', () => {
    const c = registryCard(ep as any, { id: 'api-anthropic-claude-fable-5-1' } as any);
    expect(c.priceIn).toBeNull();
    expect(c.priceSource).toBeNull();
  });
  it('carries model prices, a no-think flag and a context window', () => {
    const c = registryCard(ep as any, { id: 'tt-qwen3.8-27b', usdPerMTokIn: 0.1, usdPerMTokOut: 0.3, thinking: 'off', contextWindow: 131072 } as any);
    expect(c.priceIn).toBe(0.1);
    expect(c.priceOut).toBe(0.3);
    expect(c.priceSource).toBe('entry');
    expect(c.thinkingOff).toBe(true);
    expect(c.contextChars).toBeGreaterThan(0);
  });
});

describe('registry pricing — built-in twins (roster 2026-10-06 C-1)', () => {
  const ep = { label: 'cql-litellm', settings: {}, frontierModelIds: [], providerClass: 'open' as const };
  it.each([
    ['api-optimize-zai-glm-5.3', 'glm-5.3'],
    ['api-deepseek-v4-pro', 'deepseek-v4-pro'],
    ['api-optimize-alibaba-deepseek-v4.1-flash', 'deepseek-flash'],
    ['api-optimize-moonshot-kimi-k3', 'kimi-k3'],
    ['api-optimize-alibaba-qwen3.8-flash', null],
    ['api-optimize-zai-glm-5.3-flash', 'glm-5.3-flash'], // build 2026-10-08 Q-1: now a priced built-in
    ['api-anthropic-claude-fable-5-1', null],
  ])('%s → twin %s', (id, twin) => {
    expect(builtInTwinOf(id)).toBe(twin);
  });
  it('an unpriced gateway model takes its twin\'s list price; an entry or endpoint price always wins', () => {
    expect(registryCard(ep as any, { id: 'api-optimize-moonshot-kimi-k3' } as any)).toMatchObject({ priceIn: 3, priceOut: 15, priceSource: 'twin' });
    expect(registryCard(ep as any, { id: 'api-optimize-moonshot-kimi-k3', usdPerMTokIn: 0.5 } as any)).toMatchObject({ priceIn: 0.5, priceOut: null, priceSource: 'entry' });
    expect(registryCard({ ...ep, settings: { usdPerMTokIn: 0.2, usdPerMTokOut: 0.4 } } as any, { id: 'api-optimize-moonshot-kimi-k3' } as any)).toMatchObject({ priceIn: 0.2, priceOut: 0.4, priceSource: 'endpoint' });
    expect(registryCard(ep as any, { id: 'api-optimize-alibaba-qwen3.8-flash' } as any)).toMatchObject({ priceIn: null, priceSource: null });
  });
});

describe('catalogBySpec', () => {
  it('indexes cards by spec', () => {
    const m = catalogBySpec([builtInCard('glm-5.3', { supportsVision: false, envKey: 'ZAI_API_KEY' } as any, {} as any)]);
    expect(m.get('glm-5.3')?.family).toBe('glm');
  });
});

describe('listChatModelCatalog — the auto-pick policy rides every registry card (roster 2026-10-06 C-1)', () => {
  it("policy 'all': the frontier card is auto-eligible; 'open_only': it is not; open cards are eligible either way", async () => {
    mockAutoPickPolicy.mockResolvedValueOnce('all');
    let cards = await listChatModelCatalog();
    expect(cards.find((c) => c.spec === 'cql:api-anthropic-claude-fable-5-1')).toMatchObject({ frontier: true, autoEligible: true });
    mockAutoPickPolicy.mockResolvedValueOnce('open_only');
    cards = await listChatModelCatalog();
    expect(cards.find((c) => c.spec === 'cql:api-anthropic-claude-fable-5-1')).toMatchObject({ frontier: true, autoEligible: false });
    expect(cards.find((c) => c.spec === 'cql:tt-qwen3.8-27b')?.autoEligible).toBe(true);
    expect(cards.filter((c) => c.source === 'builtin').every((c) => c.autoEligible)).toBe(true);
  });
});
