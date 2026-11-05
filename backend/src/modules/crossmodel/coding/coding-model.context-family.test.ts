/**
 * audit 2026-10-06 T1-1 — gateway seats ran at a 160k-char context budget.
 *
 * Every lane + supervisor on `cql-litellm:api-optimize-zai-glm-5.3` (fallback
 * `…moonshot-kimi-k3`) had NO contextWindow on its registry entry (LiteLLM's
 * /v1/models publishes none), so registryContextChars() returned the 160k
 * default while the SAME model on the built-in seat runs at 4,000,000 —
 * 7,426 compactions / 48 h on 30 gateway lanes vs 28 on 2 built-in lanes.
 *
 * Pinned here: a registry model with no published window whose id names a
 * known built-in family gets that built-in's contextChars ('family'); a
 * published window still wins ('registry'); unknown ids keep the default
 * ('default'); smaller variants / older generations never inherit a flagship
 * window; the kill switch restores the pre-fix shape byte-for-byte; the
 * size-rejection ceiling min-merges and never drops below the default.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResolveRegistryModel = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

import {
  contextFamilyFor, registryContextBudget, registryContextChars, resolveProvider, resolveProviderForRun,
  learnContextCharCeiling, learnedContextCharCeiling, __resetContextCharCeilingsForTests,
} from './coding-model';

const GATEWAY = (model: string, extra: Record<string, any> = {}) => ({
  url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'sk-gw', model, label: 'cql-litellm',
  supportsVision: false, coding: true, chatCapable: true, ...extra,
});

beforeEach(() => {
  mockResolveRegistryModel.mockReset();
  delete process.env.REGISTRY_CONTEXT_FAMILY_DISABLED;
  __resetContextCharCeilingsForTests();
});

describe('contextFamilyFor — which built-in a registry model id sizes like', () => {
  it.each([
    ['api-optimize-zai-glm-5.3', 'glm-5.3'],
    ['zai-org/GLM-5.3-FP8', 'glm-5.3'],
    ['glm-5.4', 'glm-5.3'],
    ['api-optimize-zai-glm-5.3-flash', 'glm-5.3-flash'],
    ['spark-glm-5.3-flash', 'glm-5.3-flash'],
    ['api-optimize-moonshot-kimi-k3', 'kimi-k3'],
    ['kimi-k3-turbo', 'kimi-k3'],
    ['api-optimize-alibaba-deepseek-v4.1-flash', 'deepseek-flash'],
    ['deepseek-v4-pro', 'deepseek-flash'],
    ['deepseek-flash', 'deepseek-flash'],
  ])('%s → %s', (id, fam) => {
    expect(contextFamilyFor(id)).toBe(fam);
  });

  it.each([
    'glm-5.2',            // GLM-5.2 had a 200k window — never the 5.3 budget
    'glm-5',
    'glm-5.3-air',        // a size-reduced variant
    'glm-5.3-mini',
    'deepseek-v3',        // pre-V4 DeepSeek (64–128k)
    'deepseek-chat',
    'kimi-k2.6',
    'kimi-k3x',
    'qwen3:32b',          // the qwen built-in budget (120k) is BELOW the default — never listed
    'api-optimize-alibaba-qwen3.8-flash',
    'api-openai-gpt-6-astra',
    'llama-3-70b',
    '',
  ])('%s → no family', (id) => {
    expect(contextFamilyFor(id)).toBeNull();
  });
});

describe('registryContextBudget — published window > model family > default', () => {
  it('no window + a known family → the BUILT-IN contextChars (source family)', () => {
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3')).toEqual({ chars: resolveProvider('glm-5.3').contextChars, source: 'family' });
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3').chars).toBe(4_000_000);
    expect(registryContextBudget(null, 'api-optimize-moonshot-kimi-k3')).toEqual({ chars: 800_000, source: 'family' });
    expect(registryContextBudget(undefined, 'api-optimize-alibaba-deepseek-v4.1-flash')).toEqual({ chars: 4_000_000, source: 'family' });
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3-flash')).toEqual({ chars: 400_000, source: 'family' });
  });

  it('a published window always wins (source registry) — even a SMALLER one than the family', () => {
    expect(registryContextBudget(131_072, 'zai-org/GLM-5.3-FP8')).toEqual({ chars: registryContextChars(131_072), source: 'registry' });
    expect(registryContextBudget(131_072, 'zai-org/GLM-5.3-FP8').chars).toBe(262_144);
  });

  it('unknown family / no window → the 160k default (source default)', () => {
    expect(registryContextBudget(undefined, 'qwen3:32b')).toEqual({ chars: 160_000, source: 'default' });
    expect(registryContextBudget(0, 'llama-3-70b')).toEqual({ chars: 160_000, source: 'default' });
  });

  it('kill switch REGISTRY_CONTEXT_FAMILY_DISABLED=1 → the pre-fix budget, no source field', () => {
    process.env.REGISTRY_CONTEXT_FAMILY_DISABLED = '1';
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3')).toEqual({ chars: 160_000 });
    expect(registryContextBudget(200_000, 'api-optimize-zai-glm-5.3')).toEqual({ chars: 400_000 });
  });
});

describe('resolveProviderForRun — the gateway seat the audit measured', () => {
  it('cql-litellm:api-optimize-zai-glm-5.3 with no contextWindow runs at glm-5.3\'s 4M budget, source family', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-optimize-zai-glm-5.3'));
    const p = await resolveProviderForRun('cql-litellm:api-optimize-zai-glm-5.3', 'u1');
    expect(p.label).toBe('cql-litellm (custom endpoint)');
    expect(p.contextChars).toBe(4_000_000);
    expect(p.contextCharsSource).toBe('family');
  });

  it('the kimi fallback on the same gateway gets K3\'s 800k; a published window is respected', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-optimize-moonshot-kimi-k3'));
    expect(await resolveProviderForRun('cql-litellm:api-optimize-moonshot-kimi-k3')).toMatchObject({ contextChars: 800_000, contextCharsSource: 'family' });
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-optimize-zai-glm-5.3', { contextWindow: 100_000 }));
    expect(await resolveProviderForRun('cql-litellm:api-optimize-zai-glm-5.3')).toMatchObject({ contextChars: 200_000, contextCharsSource: 'registry' });
  });

  it('kill switch: 160k and NO contextCharsSource key (byte-identical ProviderConfig)', async () => {
    process.env.REGISTRY_CONTEXT_FAMILY_DISABLED = '1';
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-optimize-zai-glm-5.3'));
    const p = await resolveProviderForRun('cql-litellm:api-optimize-zai-glm-5.3');
    expect(p.contextChars).toBe(160_000);
    expect('contextCharsSource' in p).toBe(false);
  });

  it('built-ins never carry a source (unchanged)', () => {
    expect('contextCharsSource' in resolveProvider('glm-5.3')).toBe(false);
  });
});

describe('learnContextCharCeiling — the self-correction for a family guess too big for a deployment', () => {
  const P = { url: 'http://vllm:8000/v1/chat/completions', model: 'zai-org/GLM-5.3-FP8' };
  it('85 % of the rejected transcript, min-merged, never below the 160k default; keyed by endpoint+model', () => {
    expect(learnedContextCharCeiling(P)).toBeUndefined();
    expect(learnContextCharCeiling(P, 600_000)).toBe(510_000);
    expect(learnContextCharCeiling(P, 900_000)).toBe(510_000); // a larger rejection never raises it
    expect(learnContextCharCeiling(P, 400_000)).toBe(340_000);
    expect(learnContextCharCeiling(P, 50_000)).toBe(160_000);  // floor
    expect(learnedContextCharCeiling({ ...P, model: 'other' })).toBeUndefined();
  });
});
