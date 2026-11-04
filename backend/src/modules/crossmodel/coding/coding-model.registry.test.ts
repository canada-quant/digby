/**
 * coding-model.ts registry-aware resolution (Digby Edge Phase 2).
 * resolveProviderForRun: a '<label>:<modelId>' spec resolves to the custom
 * endpoint's ProviderConfig; anything else — built-ins, unknown/disabled
 * specs, non-coding entries — falls back to the built-in switch BYTE-IDENTICAL
 * to resolveProvider(normalizeCodingModel(...)). The registry seam
 * (model-endpoints.service, dynamically imported) is mocked here.
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
  resolveProvider, resolveProviderForRun, modelSupportsVisionForRun, normalizeCodingModel,
  seatUnservableReason, seatServability,
} from './coding-model';

beforeEach(() => mockResolveRegistryModel.mockReset());

const REG = {
  url: 'http://192.168.1.50:11434/v1/chat/completions',
  apiKey: 'sk-registry',
  model: 'qwen3:32b',
  label: 'my-ollama',
  supportsVision: true,
  coding: true,
};

describe('resolveProviderForRun', () => {
  it('resolves an enabled, coding-capable registry spec to a ProviderConfig', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(REG);
    const p = await resolveProviderForRun('my-ollama:qwen3:32b', 'u1');
    expect(mockResolveRegistryModel).toHaveBeenCalledWith('my-ollama:qwen3:32b', 'u1');
    expect(p).toEqual({
      url: 'http://192.168.1.50:11434/v1/chat/completions',
      apiKey: 'sk-registry',
      model: 'qwen3:32b',
      spec: 'my-ollama:qwen3:32b', // audit 2026-10-08 W3-4: the registry spec — the spend rows' model key
      label: 'my-ollama (custom endpoint)',
      extra: { max_tokens: 131072, reasoning_effort: 'max' }, // 2026-09-29: max effort + max output (qwen3 family cap)
      contextChars: 160_000,
      contextCharsSource: 'default', // audit 2026-10-06 T1-1: no window, no known family → the 160k default (named)
      supportsVision: true,
      reasoningEffort: 'auto', // 2026-09-29: 'auto' = send max, step down + latch on a rejection
    });
  });

  it('2026-09-27: carries the registry limits (maxTools / providerClass / reasoningEffort) and sizes the budget from a published context window', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, chatCapable: true, maxTools: 128, providerClass: 'openai', reasoningEffort: 'unsupported', contextWindow: 200_000 });
    const p = await resolveProviderForRun('my-ollama:qwen3:32b', 'u1');
    expect(p).toMatchObject({ maxTools: 128, providerClass: 'openai', reasoningEffort: 'unsupported', contextChars: 400_000 });
    // chatCapable:false (an embeddings / rerank / decision kind) falls back to the built-in exactly like coding:false did.
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, coding: false, chatCapable: false, kind: 'embeddings' });
    const fb = await resolveProviderForRun('my-ollama:qwen3:32b', 'u1');
    expect(fb.label).not.toContain('(custom endpoint)');
  });

  it('resolves a keyless endpoint with apiKey undefined', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, apiKey: undefined });
    const p = await resolveProviderForRun('my-ollama:qwen3:32b');
    expect(p.apiKey).toBeUndefined();
  });

  it('built-in ids skip the registry entirely and are byte-identical to resolveProvider', async () => {
    for (const id of ['glm-5.3', 'deepseek-flash', 'kimi-k3', 'kimi-k2.6', 'qwen3.6-27b'] as const) {
      const p = await resolveProviderForRun(id, 'u1');
      expect(p).toEqual(resolveProvider(id));
    }
    expect(mockResolveRegistryModel).not.toHaveBeenCalled();
  });

  it('unknown registry spec → built-in fallback (normalizeCodingModel → glm-5.3)', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(null); // unknown/disabled row
    const p = await resolveProviderForRun('my-ollama:gone', 'u1');
    expect(p).toEqual(resolveProvider(normalizeCodingModel('my-ollama:gone')));
    expect(p.url).toBe(resolveProvider('glm-5.3').url);
  });

  it('a registry entry NOT flagged coding falls back to built-ins', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, coding: false });
    const p = await resolveProviderForRun('my-ollama:qwen3:32b', 'u1');
    expect(p).toEqual(resolveProvider('glm-5.3'));
  });

  it('a throwing registry seam falls back to built-ins', async () => {
    mockResolveRegistryModel.mockRejectedValueOnce(new Error('db down'));
    const p = await resolveProviderForRun('my-ollama:qwen3:32b', 'u1');
    expect(p).toEqual(resolveProvider('glm-5.3'));
  });
});

describe('modelSupportsVisionForRun', () => {
  it('honors the registry entry vision flag', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, supportsVision: true, coding: false });
    expect(await modelSupportsVisionForRun('my-ollama:llava:13b', 'u1')).toBe(true);
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, supportsVision: false });
    expect(await modelSupportsVisionForRun('my-ollama:qwen3:32b', 'u1')).toBe(false);
  });

  it('falls back to the built-in answer for unknown specs and built-in ids', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    expect(await modelSupportsVisionForRun('my-ollama:gone', 'u1')).toBe(false); // → glm-5.3 (text-only)
    expect(await modelSupportsVisionForRun('kimi-k3')).toBe(true);
    expect(mockResolveRegistryModel).toHaveBeenCalledTimes(1); // built-in id skipped the registry
  });
});

describe('seatUnservableReason (keyless-Edge honesty check, 2026-09-04)', () => {
  const ENV_KEYS = ['MOONSHOT_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  });

  it('a resolving custom endpoint is servable even KEYLESS (Ollama/llama.cpp)', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, apiKey: undefined });
    expect(await seatUnservableReason('my-ollama:qwen3:32b', 'u1')).toBeNull();
  });

  it('a built-in with its provider key set is servable', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-m';
    expect(await seatUnservableReason('kimi-k3', 'u1')).toBeNull();
  });

  it('a KEYLESS built-in names the model, provider AND the exact .env variable (owner ask 2026-09-05)', async () => {
    const reason = await seatUnservableReason('kimi-k3', 'u1');
    expect(reason).toContain('kimi-k3');
    expect(reason).toContain('Moonshot');
    expect(reason).toContain('MOONSHOT_API_KEY');
    // Structured shape for the UI badge ("add MOONSHOT_API_KEY").
    expect(await seatServability('deepseek-flash', 'u1')).toMatchObject({
      reason: expect.stringContaining('DEEPSEEK_API_KEY'),
      missingEnvKey: 'DEEPSEEK_API_KEY',
    });
  });

  it('a stale colon-spec with a KEYLESS fallback says both halves; with a keyed fallback it is servable (silent-fallback status quo)', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    const reason = await seatUnservableReason('ghost:model', 'u1');
    expect(reason).toContain('no longer resolves');
    expect(reason).toContain('glm-5.3');
    expect(reason).toContain('ZAI_API_KEY');
    process.env.ZAI_API_KEY = 'id.secret';
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    expect(await seatUnservableReason('ghost:model', 'u1')).toBeNull();
  });

  it('fails OPEN when resolution itself throws', async () => {
    mockResolveRegistryModel.mockRejectedValueOnce(new Error('db down'));
    // resolveProviderForRun already swallows this into the glm fallback; with a
    // key set the seat is servable, and a resolver-layer throw never blocks.
    process.env.ZAI_API_KEY = 'id.secret';
    expect(await seatUnservableReason('my-ollama:qwen3:32b', 'u1')).toBeNull();
  });
});
