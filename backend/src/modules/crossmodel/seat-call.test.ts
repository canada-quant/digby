/**
 * seat-call.ts — the non-streaming seat runtime's PAYLOAD CONTRACT (2026-09-22).
 *
 * Pins: provider extras first but the CALLER's output budget wins (a provider's
 * 65k agent-seat max_tokens must not override a 4k description budget); Kimi
 * gets max_completion_tokens (+ its reasoning_effort knob) and never max_tokens;
 * DeepSeek built-ins run thinking OFF unless kept; custom endpoints try the
 * no-think directive first; tool calls come back in the OpenAI shape; a leading
 * <think> block is stripped; the provider chain is seat → custom fallback →
 * built-in, deduplicated.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockResolveRoleModel = jest.fn(async (_r: string) => '');
const mockResolveRoleFallback = jest.fn(async (_r: string) => '');
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...(a as [string])),
}));
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: async (spec: string) => (spec === 'my-node:Qwen/Qwen3-VL-32B' ? {
    url: 'http://10.0.0.9:8000/v1/chat/completions', baseUrl: 'http://10.0.0.9:8000/v1', apiKey: 'sk-node',
    model: 'Qwen/Qwen3-VL-32B', label: 'my-node', supportsVision: true, coding: true, matryoshka: false, thinkingOff: false,
  } : null),
}));

import axios from 'axios';
import { resolveProvider } from './coding/coding-model';
import { seatCompletion, seatProviderChain, imageUrlPart, providerKeyMissing, resolveSeat } from './seat-call';

const mockedPost = axios.post as jest.Mock;
const ok = (message: any, finish = 'stop') => ({ data: { choices: [{ message, finish_reason: finish }] } });

const ENV = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRoleModel.mockResolvedValue('');
  mockResolveRoleFallback.mockResolvedValue('');
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) process.env[k] = `sk-${k.toLowerCase()}`;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

describe('seatCompletion payload contract', () => {
  it('GLM built-in: provider extras ride along, the caller budget replaces max_tokens, effort override applies, <think> stripped', async () => {
    mockedPost.mockResolvedValueOnce(ok({ content: '<think>hmm</think>\nA red square.', reasoning_content: 'hmm' }));
    const p = resolveProvider('glm-5.3');
    const r = await seatCompletion(p, [{ role: 'user', content: 'hi' }], { maxTokens: 4000, timeoutMs: 1000, reasoningEffort: 'high', temperature: 0.2 });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(p.url);
    expect(body.model).toBe('glm-5.3');
    expect(body.max_tokens).toBe(4000);           // caller wins over the 65536 agent-seat cap
    expect(body.reasoning_effort).toBe('high');   // overrode the built-in 'max'
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBeUndefined();
    expect(opts.headers.Authorization).toBe('Bearer sk-zai_api_key');
    expect(r.text).toBe('A red square.');
    expect(r.hadReasoning).toBe(true);
    expect(r.finishReason).toBe('stop');
  });

  it('DeepSeek built-in: thinking switched OFF and reasoning_effort dropped unless keepThinking', async () => {
    mockedPost.mockResolvedValue(ok({ content: 'ok' }));
    const p = resolveProvider('deepseek-flash');
    await seatCompletion(p, [{ role: 'user', content: 'hi' }], { maxTokens: 512, timeoutMs: 1000, reasoningEffort: 'high' });
    expect(mockedPost.mock.calls[0][1]).toMatchObject({ model: 'deepseek-flash', max_tokens: 512, thinking: { type: 'disabled' } });
    expect(mockedPost.mock.calls[0][1].reasoning_effort).toBeUndefined();
    await seatCompletion(p, [{ role: 'user', content: 'hi' }], { maxTokens: 512, timeoutMs: 1000, reasoningEffort: 'high', keepThinking: true });
    expect(mockedPost.mock.calls[1][1]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('Kimi built-in: max_completion_tokens carries the budget, max_tokens/stream_options are stripped, effort knob is set', async () => {
    mockedPost.mockResolvedValueOnce(ok({ content: 'ok' }));
    const p = resolveProvider('kimi-k3');
    await seatCompletion(p, [{ role: 'user', content: 'hi' }], { maxTokens: 2048, timeoutMs: 1000, reasoningEffort: 'low', temperature: 0.5 });
    const body = mockedPost.mock.calls[0][1];
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.reasoning_effort).toBe('low');
  });

  it('tools ride as OpenAI function tools with tool_choice auto; tool_calls come back normalized', async () => {
    mockedPost.mockResolvedValueOnce(ok({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"x":1}' } }, { id: 'c2', type: 'function', function: { name: 'done', arguments: { message: 'ok' } } }],
    }, 'tool_calls'));
    const tools = [{ type: 'function', function: { name: 'click', description: 'click', parameters: { type: 'object' } } }];
    const r = await seatCompletion(resolveProvider('glm-5.3-flash'), [{ role: 'user', content: [imageUrlPart('image/png', 'AAAA'), { type: 'text', text: 'go' }] }], { maxTokens: 1000, timeoutMs: 1000, tools });
    const body = mockedPost.mock.calls[0][1];
    expect(body.tools).toBe(tools);
    expect(body.tool_choice).toBe('auto');
    expect(body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'click', arguments: '{"x":1}' }, { id: 'c2', name: 'done', arguments: '{"message":"ok"}' }]);
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('tool_calls');
  });

  it('glm-5.3-flash built-in contract: thinking enabled at LOW effort by default (the vision-utility shape)', async () => {
    mockedPost.mockResolvedValueOnce(ok({ content: 'a cat' }));
    await seatCompletion(resolveProvider('glm-5.3-flash'), [{ role: 'user', content: 'hi' }], { maxTokens: 100, timeoutMs: 1000 });
    expect(mockedPost.mock.calls[0][1]).toMatchObject({ model: 'glm-5.3-flash', thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 100 });
  });
});

describe('seat resolution + chain', () => {
  it('resolveSeat: no override → the built-in default; an override → the registry provider (custom endpoint)', async () => {
    expect((await resolveSeat('vision_describe', 'glm-5.3-flash')).provider.model).toBe('glm-5.3-flash');
    mockResolveRoleModel.mockResolvedValue('my-node:Qwen/Qwen3-VL-32B');
    const seat = await resolveSeat('vision_describe', 'glm-5.3-flash');
    expect(seat.isCustom).toBe(true);
    expect(seat.provider).toMatchObject({ model: 'Qwen/Qwen3-VL-32B', url: 'http://10.0.0.9:8000/v1/chat/completions' });
  });

  it('seatProviderChain: seat → custom fallback → built-in default, deduplicated', async () => {
    mockResolveRoleModel.mockResolvedValue('my-node:Qwen/Qwen3-VL-32B');
    mockResolveRoleFallback.mockResolvedValue('deepseek-flash');
    const chain = await seatProviderChain('vision_describe', 'glm-5.3-flash');
    expect(chain.map(p => p.model)).toEqual(['Qwen/Qwen3-VL-32B', 'deepseek-flash', 'glm-5.3-flash']);
    // Built-in seat with no fallback → just itself.
    mockResolveRoleModel.mockResolvedValue('');
    mockResolveRoleFallback.mockResolvedValue('');
    expect((await seatProviderChain('vision_describe', 'glm-5.3-flash')).map(p => p.model)).toEqual(['glm-5.3-flash']);
  });

  it('providerKeyMissing names the exact env var for a keyless built-in and passes custom endpoints', () => {
    delete process.env.ZAI_API_KEY;
    expect(providerKeyMissing(resolveProvider('glm-5.3-flash'))).toContain('ZAI_API_KEY');
    expect(providerKeyMissing({ url: 'http://x/v1/chat/completions', apiKey: undefined, model: 'm', label: 'n (custom endpoint)', extra: {} })).toBeNull();
  });
});
