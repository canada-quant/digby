/**
 * audit 2026-10-08 W2-3 — gateway models with no built-in family ran at the
 * 160k-char registry default.
 *
 * REPLAY: the One Piece lane (project-pinned `cql-litellm:api-alibaba-qwen3.8-max`,
 * modelSource project) wrote `context_budget` rows `{model: api-alibaba-qwen3.8-max,
 * budget: 160000, source: "default", seatContextChars: 160000}` on every run
 * (runs 45c4f136, 701e3409, 0b9493dd, 79d9a7b4 on 2026-10-08) and logged 650
 * compactions in 18 h. None of the gateway's 48 registry entries carries a
 * contextWindow. Precedence now: published window > the gateway's /model/info
 * window > built-in family > verified gateway family > default.
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

jest.mock('axios');
import axios from 'axios';
import {
  gatewayContextFamilyFor, isInferredContextSource, registryContextBudget, registryContextChars, resolveProviderForRun,
} from './coding-model';
import { __resetGatewayModelInfoForTests } from './gateway-model-info';

const mockGet = axios.get as unknown as jest.Mock;

const GATEWAY = (model: string, extra: Record<string, any> = {}) => ({
  url: 'https://llm.example.com/v1/chat/completions', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-gw', model, label: 'cql-litellm',
  supportsVision: false, coding: true, chatCapable: true, ...extra,
});

const ENV_KEYS = ['REGISTRY_CONTEXT_FAMILY_DISABLED', 'REGISTRY_CONTEXT_GATEWAY_FAMILY_DISABLED', 'GATEWAY_MODEL_INFO_RUNTIME_DISABLED', 'GATEWAY_MODEL_INFO_RUNTIME_IN_TEST'];
beforeEach(() => {
  mockResolveRegistryModel.mockReset();
  mockGet.mockReset();
  __resetGatewayModelInfoForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('gatewayContextFamilyFor — the verified non-built-in families', () => {
  it.each([
    ['api-alibaba-qwen3.8-max', 'qwen3.7+-hosted', 800_000],
    ['api-optimize-alibaba-qwen3.8-max', 'qwen3.7+-hosted', 800_000],
    ['api-alibaba-qwen3.8-flash', 'qwen3.7+-hosted', 800_000],
    ['api-optimize-alibaba-qwen3.8-flash', 'qwen3.7+-hosted', 800_000],
    ['api-optimize-alibaba-qwen3.7-plus', 'qwen3.7+-hosted', 800_000],
    ['api-optimize-alibaba-qwen3.7-max', 'qwen3.7+-hosted', 800_000],
    ['mimo-v26-flash-rl', 'mimo-v2.6-flash', 400_000],
    ['spark-mimo-v26-flash-rl', 'mimo-v2.6-flash', 400_000],
    ['api-optimize-moonshot-kimi-for-coding', 'kimi-for-coding', 400_000],
  ])('%s → %s (%d chars)', (id, key, chars) => {
    expect(gatewayContextFamilyFor(id)).toMatchObject({ key, chars });
  });

  it.each([
    'spark-qwen3.8-flash-next', // self-hosted open checkpoint (262k native) — not the hosted SKU
    'tt-qwen3.8-flash-next',
    'tt-qwen3.8-27b',
    'api-alibaba-qwen3.8-open',
    'qwen3.6-flash',            // the built-in 3.6 tier stays deliberately lean
    'api-optimize-alibaba-qwen3.6-flash',
    'qwen3:32b',
    'api-optimize-zai-glm-5.3', // built-in family — the other table
    'api-openai-gpt-5.6-sol',
    '',
  ])('%s → no gateway family', (id) => {
    expect(gatewayContextFamilyFor(id)).toBeNull();
  });
});

describe('registryContextBudget — published > family > model_info > gateway_family > default', () => {
  it('REPLAY: the One Piece seat id (no window) → 800,000 chars, source gateway_family (was 160,000 default)', () => {
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max')).toEqual({ chars: 800_000, source: 'gateway_family' });
    expect(registryContextBudget(undefined, 'api-optimize-alibaba-qwen3.8-flash')).toEqual({ chars: 800_000, source: 'gateway_family' });
    expect(registryContextBudget(undefined, 'spark-qwen3.8-flash-next')).toEqual({ chars: 160_000, source: 'default' });
    expect(registryContextBudget(undefined, 'tt-qwen3.8-27b')).toEqual({ chars: 160_000, source: 'default' });
  });

  it('the gateway /model/info window beats the gateway-family table; a published window and a LIVE-VERIFIED built-in family beat it', () => {
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max', 983_616)).toEqual({ chars: registryContextChars(983_616), source: 'model_info' });
    // the 10-06 GLM / Kimi fix is never undone by a (possibly generic) gateway model-map value
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3', 200_000)).toEqual({ chars: 4_000_000, source: 'family' });
    expect(registryContextBudget(undefined, 'api-optimize-moonshot-kimi-k3', 131_072)).toEqual({ chars: 800_000, source: 'family' });
    expect(registryContextBudget(131_072, 'api-alibaba-qwen3.8-max', 983_616)).toEqual({ chars: 262_144, source: 'registry' });
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max', 0)).toEqual({ chars: 800_000, source: 'gateway_family' });
  });

  it('built-in families keep their own budget (unchanged)', () => {
    expect(registryContextBudget(undefined, 'api-optimize-moonshot-kimi-k3')).toEqual({ chars: 800_000, source: 'family' });
  });

  it('REGISTRY_CONTEXT_GATEWAY_FAMILY_DISABLED=1 drops ONLY the new table', () => {
    process.env.REGISTRY_CONTEXT_GATEWAY_FAMILY_DISABLED = '1';
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max')).toEqual({ chars: 160_000, source: 'default' });
    expect(registryContextBudget(undefined, 'api-optimize-zai-glm-5.3')).toEqual({ chars: 4_000_000, source: 'family' });
  });

  it('REGISTRY_CONTEXT_FAMILY_DISABLED=1 restores the pre-fix 160k for EVERY inferred sizing (model_info included)', () => {
    process.env.REGISTRY_CONTEXT_FAMILY_DISABLED = '1';
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max')).toEqual({ chars: 160_000 });
    expect(registryContextBudget(undefined, 'api-alibaba-qwen3.8-max', 983_616)).toEqual({ chars: 160_000 });
  });

  it('isInferredContextSource: the sizings the size-rejection ceiling may correct', () => {
    expect(['family', 'gateway_family', 'model_info'].every(isInferredContextSource)).toBe(true);
    expect(['registry', 'default', undefined, null, 'builtin'].some(isInferredContextSource)).toBe(false);
  });
});

describe('resolveProviderForRun — the One Piece seat', () => {
  it('REPLAY: cql-litellm:api-alibaba-qwen3.8-max with no contextWindow runs at 800,000 chars, source gateway_family; no fetch under jest', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-alibaba-qwen3.8-max'));
    const p = await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max', 'u1');
    expect(p).toMatchObject({ contextChars: 800_000, contextCharsSource: 'gateway_family', label: 'cql-litellm (custom endpoint)' });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('with the run-time read on, the gateway\'s /model/info window sizes the seat (min across deployments)', async () => {
    process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST = '1';
    mockGet.mockResolvedValueOnce({ data: { data: [
      { model_name: 'api-alibaba-qwen3.8-max', model_info: { max_input_tokens: 983_616 } },
      { model_name: 'api-alibaba-qwen3.8-max', model_info: { max_input_tokens: 500_000 } },
    ] } });
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-alibaba-qwen3.8-max'));
    const p = await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max', 'u1');
    expect(p).toMatchObject({ contextChars: registryContextChars(500_000), contextCharsSource: 'model_info' });
    expect(mockGet.mock.calls[0][0]).toBe('https://llm.example.com/v1/model/info');
  });

  it('a published contextWindow skips the fetch entirely', async () => {
    process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST = '1';
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-alibaba-qwen3.8-max', { contextWindow: 131_072 }));
    expect(await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max')).toMatchObject({ contextChars: 262_144, contextCharsSource: 'registry' });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a gateway that answers no window (or fails) falls back to the family tables; baseUrl derives from url when absent', async () => {
    process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST = '1';
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    const reg: any = GATEWAY('api-alibaba-qwen3.8-max');
    delete reg.baseUrl;
    mockResolveRegistryModel.mockResolvedValueOnce(reg);
    expect(await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max')).toMatchObject({ contextChars: 800_000, contextCharsSource: 'gateway_family' });
    expect(mockGet.mock.calls[0][0]).toBe('https://llm.example.com/v1/model/info');
  });

  it('kill switches: GATEWAY_MODEL_INFO_RUNTIME_DISABLED=1 → no fetch; REGISTRY_CONTEXT_FAMILY_DISABLED=1 → 160k, no source key', async () => {
    process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST = '1';
    process.env.GATEWAY_MODEL_INFO_RUNTIME_DISABLED = '1';
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-alibaba-qwen3.8-max'));
    expect(await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max')).toMatchObject({ contextChars: 800_000, contextCharsSource: 'gateway_family' });
    expect(mockGet).not.toHaveBeenCalled();
    delete process.env.GATEWAY_MODEL_INFO_RUNTIME_DISABLED;
    process.env.REGISTRY_CONTEXT_FAMILY_DISABLED = '1';
    mockResolveRegistryModel.mockResolvedValueOnce(GATEWAY('api-alibaba-qwen3.8-max'));
    const p = await resolveProviderForRun('cql-litellm:api-alibaba-qwen3.8-max');
    expect(p.contextChars).toBe(160_000);
    expect('contextCharsSource' in p).toBe(false);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
