/**
 * 2026-09-29 — MAX OUTPUT (and max effort) on every endpoint. Owner: "it is
 * supposed to use max reasoning and max output tokens everywhere regardless of
 * the litellm provider / endpoint". Supersedes the morning's thinking budget
 * (glm-5.x / kimi-k3 only, 65,536; a budget 400 → 16,384 latched).
 *
 * Pins: (1) the live-probed vendor maximums per family + the 131,072 default;
 * (2) resolveProviderForRun gives every custom-endpoint model its max output +
 * reasoning_effort 'max' (no-think / 'unsupported' / kill switches respected);
 * (3) built-in agent seats carry the vendor maximum (kill switch → 65,536);
 * (4) outputBudgetFixForRejection parses the providers' REAL 400 phrasings;
 * (5) runModelTurn retries at the NAMED cap and learns it, retries a context
 * overflow at C − M and learns the window, falls back to 16,384 once when
 * nothing parses, and composes an effort fix with a budget fix in one turn.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// Ticket c6af45ef (log-signal family cf7baffd): the output-budget REPAIR is
// now logHandled + a provider_rejected loop-metrics row, so runModelTurn's
// budget ladder imports loop-metrics.service — whose own chain reaches
// config/env (process.exit(1) in a jest worker). Same stub the sibling
// coding-model suites carry (stall-watchdog, system-first, efdb3d31).
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { PROVIDER_REJECTED: 'provider_rejected' },
}));
const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

import axios from 'axios';
import {
  buildTurnPayload, runModelTurn, resolveProviderForRun, resolveProvider, ProviderConfig,
  customEndpointThinkingBudgetExtra, customEndpointEffortExtra, maxOutputTokensFor,
  outputBudgetFixForRejection, learnedOutputCap, learnedContextWindow, learnOutputCap,
  CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT, DEFAULT_TURN_MAX_TOKENS, THINKING_OFF_EXTRA,
  __resetThinkingBudgetLatchForTests, __resetReasoningEffortLatchForTests, reasoningEffortLatch,
} from './coding-model';

const mockPost = (axios as any).post as jest.Mock;
const GLM: ProviderConfig = { url: 'https://llm.example.com/v1/chat/completions', apiKey: 'sk', model: 'api-optimize-zai-glm-5.3', label: 'cql-litellm (custom endpoint)', extra: { max_tokens: 262_144, reasoning_effort: 'max' }, reasoningEffort: 'auto' };
const BUILTIN_GLM = resolveProvider('glm-5.3');
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) } });
const okStream = () => ({ data: Readable.from(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']) });
const msgs = [{ role: 'user', content: 'hi' }];
// The providers' own phrasings (live-probed 2026-09-29 on the bench box).
const ZAI_400 = 'The max_tokens parameter is illegal.：限制数值范围[1,131072]';
const DEEPSEEK_400 = 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]';
const DASHSCOPE_400 = 'litellm.BadRequestError: OpenAIException - <400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 131072]. Received Model Group=api-optimize-alibaba-qwen3.8-flash';
const OPENAI_400 = 'max_tokens is too large: 65536. This model supports at most 32768 completion tokens, whereas you provided 65536.';
const ANTHROPIC_400 = 'litellm.BadRequestError: AnthropicException - max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-fable-5-1';
const VLLM_400 = "This model's maximum context length is 32768 tokens. However, you requested 65620 tokens (84 in the messages, 65536 in the completion). Please reduce the length of the messages or completion.";

beforeEach(() => {
  jest.clearAllMocks();
  __resetThinkingBudgetLatchForTests();
  __resetReasoningEffortLatchForTests();
});

describe('maxOutputTokensFor — live-probed vendor maximums', () => {
  it.each([
    ['glm-5.3', 131_072], ['api-optimize-zai-glm-5.3', 131_072], ['api-optimize-zai-glm-5.3-flash', 131_072],
    ['deepseek-flash', 393_216], ['api-optimize-alibaba-deepseek-v4.1-flash', 393_216],
    ['api-optimize-alibaba-qwen3.8-flash', 131_072], ['qwen3:32b', 131_072],
    ['kimi-k3', 262_144], ['api-optimize-moonshot-kimi-k3', 262_144],
    ['api-optimize-moonshot-kimi-for-coding', CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT], ['llama-3-70b', CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT], ['', CUSTOM_ENDPOINT_DEFAULT_MAX_OUTPUT],
  ])('%s → %d', (id, n) => {
    expect(maxOutputTokensFor(id as string)).toBe(n);
  });
  it('custom-endpoint extras: every model gets its max output', () => {
    expect(customEndpointThinkingBudgetExtra('api-optimize-alibaba-qwen3.8-flash')).toEqual({ max_tokens: 131_072 });
  });
  it('effort extras: max unless the admin flagged the model unsupported', () => {
    expect(customEndpointEffortExtra({ reasoningEffort: 'auto' })).toEqual({ reasoning_effort: 'max' });
    expect(customEndpointEffortExtra({})).toEqual({ reasoning_effort: 'max' });
    expect(customEndpointEffortExtra({ reasoningEffort: 'unsupported' })).toEqual({});
  });
  it('built-in agent seats carry the vendor maximum', () => {
    expect((BUILTIN_GLM.extra as any).max_tokens).toBe(131_072);
    expect((resolveProvider('deepseek-flash').extra as any).max_tokens).toBe(393_216);
    expect((resolveProvider('kimi-k3').extra as any).max_completion_tokens).toBe(262_144);
  });
});

describe('resolveProviderForRun — custom endpoint extras', () => {
  const reg = (over: Record<string, any> = {}) => ({ url: 'https://llm.example.com/v1/chat/completions', apiKey: 'sk', model: 'api-optimize-zai-glm-5.3', label: 'cql-litellm', kind: 'chat', coding: true, ...over });
  it('a thinking model gets max output + reasoning_effort max', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(reg());
    const p = await resolveProviderForRun('cql-litellm:api-optimize-zai-glm-5.3');
    expect(p.label).toBe('cql-litellm (custom endpoint)');
    expect(p.extra).toEqual({ max_tokens: 131_072, reasoning_effort: 'max' });
  });
  it('a no-think model keeps the thinking-off directive and gets the output budget, never an effort', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(reg({ thinkingOff: true }));
    const p = await resolveProviderForRun('cql-litellm:api-optimize-zai-glm-5.3');
    expect(p.extra).toEqual({ ...THINKING_OFF_EXTRA, max_tokens: 131_072 });
  });
  it("the admin's 'unsupported' flag omits the effort", async () => {
    mockResolveRegistryModel.mockResolvedValueOnce(reg({ model: 'api-optimize-alibaba-qwen3.8-flash', reasoningEffort: 'unsupported' }));
    const p = await resolveProviderForRun('cql-litellm:api-optimize-alibaba-qwen3.8-flash');
    expect(p.extra).toEqual({ max_tokens: 131_072 });
  });
});

describe('outputBudgetFixForRejection — the providers\' real phrasings', () => {
  it.each([
    [ZAI_400, 262_144, { cap: 131_072, learn: 'cap' }],
    [DEEPSEEK_400, 1_048_576, { cap: 393_216, learn: 'cap' }],
    [DASHSCOPE_400, 262_144, { cap: 131_072, learn: 'cap' }],
    [OPENAI_400, 65_536, { cap: 32_768, learn: 'cap' }],
    [ANTHROPIC_400, 200_000, { cap: 128_000, learn: 'cap' }],
    [VLLM_400, 65_536, { cap: 32_768 - 84 - 1_024, learn: 'window', window: 32_768 }],
    ['too many tokens requested', 65_536, { cap: DEFAULT_TURN_MAX_TOKENS, learn: 'fallback' }],
  ])('%s (sent %d)', (detail, sent, want) => {
    expect(outputBudgetFixForRejection(sent as number, detail as string)).toEqual(want);
  });
  it('an unrelated 400, a cap already at/below the named one, or a tiny default → null', () => {
    expect(outputBudgetFixForRejection(131_072, 'messages parameter is illegal')).toBeNull();
    expect(outputBudgetFixForRejection(131_072, ZAI_400)).toEqual({ cap: DEFAULT_TURN_MAX_TOKENS, learn: 'fallback' }); // named cap is not below what was sent
    expect(outputBudgetFixForRejection(DEFAULT_TURN_MAX_TOKENS, 'too many tokens')).toBeNull();
  });
});

describe('buildTurnPayload — learned caps and windows clamp later turns', () => {
  it('a learned output cap clamps max_tokens (and max_completion_tokens for K3)', () => {
    learnOutputCap(GLM, 131_072);
    expect(buildTurnPayload(GLM, msgs, undefined).max_tokens).toBe(131_072);
    const k3 = resolveProvider('kimi-k3');
    learnOutputCap(k3, 100_000);
    expect(buildTurnPayload(k3, msgs, undefined).max_completion_tokens).toBe(100_000);
  });
});

describe('runModelTurn — the output budget ladder', () => {
  it('a named cap retries ONCE at that cap, learns it, and the next turn sends it directly', async () => {
    mockPost.mockRejectedValueOnce(http400(ZAI_400)).mockResolvedValueOnce(okStream());
    const r = await runModelTurn(GLM, msgs, undefined, {});
    expect(r.content).toBe('OK');
    expect(mockPost.mock.calls[0][1].max_tokens).toBe(262_144);
    expect(mockPost.mock.calls[1][1].max_tokens).toBe(131_072);
    expect(learnedOutputCap(GLM)).toBe(131_072);
    mockPost.mockResolvedValueOnce(okStream());
    await runModelTurn(GLM, msgs, undefined, {});
    expect(mockPost.mock.calls[2][1].max_tokens).toBe(131_072);
  });
  it('a context overflow retries at window − prompt − margin and learns the WINDOW (not a cap)', async () => {
    mockPost.mockRejectedValueOnce(http400(VLLM_400)).mockResolvedValueOnce(okStream());
    await runModelTurn({ ...GLM, extra: { max_tokens: 65_536 } }, msgs, undefined, {});
    expect(mockPost.mock.calls[1][1].max_tokens).toBe(32_768 - 84 - 1_024);
    expect(learnedContextWindow(GLM)).toBe(32_768);
    expect(learnedOutputCap(GLM)).toBeUndefined();
    const next = buildTurnPayload({ ...GLM, extra: { max_tokens: 65_536 } }, msgs, undefined);
    expect(next.max_tokens).toBeLessThanOrEqual(32_768 - 1_024);
    expect(next.max_tokens).toBeGreaterThan(30_000);
  });
  it('built-ins take the ladder too (a built-in at its vendor max never falls to 16k on a context overflow)', async () => {
    mockPost.mockRejectedValueOnce(http400("This model's maximum context length is 1048576 tokens. However, you requested 1100000 tokens (968000 in the messages, 131072 in the completion).")).mockResolvedValueOnce(okStream());
    await runModelTurn(BUILTIN_GLM, msgs, undefined, {});
    expect(mockPost.mock.calls[1][1].max_tokens).toBe(1_048_576 - 968_000 - 1_024);
  });
  it('an effort rejection and then a budget rejection are BOTH fixed in the same turn', async () => {
    mockPost
      .mockRejectedValueOnce(http400("Invalid value: 'max'. Supported values are: 'low', 'medium', and 'high'."))
      .mockRejectedValueOnce(http400(OPENAI_400.replace('65536', '262144')))
      .mockResolvedValueOnce(okStream());
    const r = await runModelTurn({ ...GLM, model: 'api-openai-gpt-6-luna' }, msgs, undefined, {});
    expect(r.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockPost.mock.calls[2][1]).toMatchObject({ reasoning_effort: 'high', max_tokens: 32_768 });
    expect(reasoningEffortLatch({ ...GLM, model: 'api-openai-gpt-6-luna' })).toBe('high');
  });
  it('no retry for another 400 or a payload already at the default', async () => {
    mockPost.mockRejectedValueOnce(http400('messages parameter is illegal'));
    await expect(runModelTurn(GLM, msgs, undefined, {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(1);
    mockPost.mockRejectedValueOnce(http400(VLLM_400));
    await expect(runModelTurn({ ...GLM, extra: {} }, msgs, undefined, {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
