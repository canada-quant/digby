/**
 * build 2026-10-08 Q-2 — Kimi K3 reasoning replay matched by FAMILY.
 *
 * REPLAY SHAPE (context.md §1.7, agent.ts:4280 before this change): the loop replayed reasoning_content
 * only when `provider.model === 'kimi-k3'`, so the owner's gateway Kimi seat
 * (`cql-litellm:api-optimize-moonshot-kimi-k3` — 2,098 chat + 197 coding runs in 14 days) never carried its
 * reasoning back, against Moonshot's Preserved-Thinking contract. Pins: the predicate; the one corrective
 * retry when a gateway REJECTS the field (and only then — never on "reasoning_content is missing"); the latch.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import axios from 'axios';
import {
  replaysReasoning, runModelTurn, latchReasoningReplayOff, reasoningReplayLatchedOff, __resetReasoningReplayLatchForTests,
  __resetReasoningEffortLatchForTests, stripReasoningContent, isReasoningContentRejection, type ProviderConfig,
} from './coding-model';

const mockPost = (axios as any).post as jest.Mock;
const GATEWAY_KIMI: ProviderConfig = { url: 'https://llm.example.com/v1/chat/completions', apiKey: 'sk', model: 'api-optimize-moonshot-kimi-k3', spec: 'cql-litellm:api-optimize-moonshot-kimi-k3', label: 'cql-litellm (custom endpoint)', extra: {}, reasoningEffort: 'auto' };
const GATEWAY_GLM: ProviderConfig = { ...GATEWAY_KIMI, model: 'api-optimize-zai-glm-5.3', spec: 'cql-litellm:api-optimize-zai-glm-5.3' };
const BUILTIN_KIMI: ProviderConfig = { url: 'https://api.moonshot.ai/v1/chat/completions', apiKey: 'k', model: 'kimi-k3', label: 'Moonshot direct', extra: {} };
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) } });
const okStream = () => ({ data: Readable.from(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']) });
const HISTORY = [
  { role: 'user', content: 'check the queue' },
  { role: 'assistant', content: 'Probing.', reasoning_content: 'I should list the queue first.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_feedback', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 't1', content: 'ok' },
];

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningReplayLatchForTests();
  __resetReasoningEffortLatchForTests();
  delete process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED;
});
afterAll(() => { delete process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED; });

describe('replaysReasoning — Kimi K3 by family', () => {
  it('the built-in kimi-k3 replays (unchanged); the GATEWAY Kimi seat now replays too', () => {
    expect(replaysReasoning(BUILTIN_KIMI)).toBe(true);
    expect(replaysReasoning(GATEWAY_KIMI)).toBe(true);
  });
  it('other gateway families and built-ins do not', () => {
    expect(replaysReasoning(GATEWAY_GLM)).toBe(false);
    expect(replaysReasoning({ ...GATEWAY_KIMI, model: 'api-optimize-moonshot-kimi-for-coding' })).toBe(false);
    expect(replaysReasoning({ url: 'https://api.z.ai/x', model: 'glm-5.3', label: 'ZAI direct' })).toBe(false);
    // a built-in-looking provider (not a custom endpoint) with a gateway id never matches by family
    expect(replaysReasoning({ ...GATEWAY_KIMI, label: 'Moonshot direct' })).toBe(false);
  });
  it('kill switch KIMI_REASONING_REPLAY_FAMILY_DISABLED=1 restores the bare-id match; a latched endpoint stops', () => {
    process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED = '1';
    expect(replaysReasoning(GATEWAY_KIMI)).toBe(false);
    expect(replaysReasoning(BUILTIN_KIMI)).toBe(true);
    delete process.env.KIMI_REASONING_REPLAY_FAMILY_DISABLED;
    latchReasoningReplayOff(GATEWAY_KIMI);
    expect(replaysReasoning(GATEWAY_KIMI)).toBe(false);
    expect(replaysReasoning(BUILTIN_KIMI)).toBe(true);
  });
});

describe('runModelTurn — a gateway that REJECTS reasoning_content', () => {
  const EXTRA_400 = 'litellm.BadRequestError: Extra inputs are not permitted: messages.1.reasoning_content';
  it('retries ONCE without the field, latches the replay off for that endpoint+model, records reasoning_replay rejected_latched', async () => {
    mockPost.mockRejectedValueOnce(http400(EXTRA_400)).mockResolvedValueOnce(okStream());
    const r = await runModelTurn(GATEWAY_KIMI, HISTORY, undefined, {});
    expect(r.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][1].messages.some((m: any) => 'reasoning_content' in m)).toBe(true);
    expect(mockPost.mock.calls[1][1].messages.some((m: any) => 'reasoning_content' in m)).toBe(false);
    expect(mockPost.mock.calls[1][1].messages.find((m: any) => m.role === 'assistant').tool_calls).toHaveLength(1); // linkage intact
    expect(reasoningReplayLatchedOff(GATEWAY_KIMI)).toBe(true);
    await new Promise((r2) => setImmediate(r2));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reasoning_replay', meta: expect.objectContaining({ outcome: 'rejected_latched', model: 'api-optimize-moonshot-kimi-k3' }) }));
  });
  it('never strips on the OPPOSITE complaint ("reasoning_content is missing") or for a built-in', async () => {
    const missing = http400('thinking is enabled but reasoning_content is missing in assistant tool call message at index 1');
    mockPost.mockRejectedValueOnce(missing);
    await expect(runModelTurn(GATEWAY_KIMI, HISTORY, undefined, {})).rejects.toBe(missing);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(reasoningReplayLatchedOff(GATEWAY_KIMI)).toBe(false);
    // A built-in (Moonshot direct) is never stripped — whatever its own cache-param retry does, every
    // request it sends still carries the field.
    mockPost.mockReset();
    mockPost.mockImplementation(async () => { throw http400(EXTRA_400); });
    await expect(runModelTurn(BUILTIN_KIMI, HISTORY, undefined, {})).rejects.toBeTruthy();
    expect(mockPost.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of mockPost.mock.calls) expect(call[1].messages.some((m: any) => 'reasoning_content' in m)).toBe(true);
    expect(reasoningReplayLatchedOff(BUILTIN_KIMI)).toBe(false);
    mockPost.mockReset();
  });
  it('the rejection matcher and the strip helper', () => {
    expect(isReasoningContentRejection(EXTRA_400)).toBe(true);
    expect(isReasoningContentRejection('messages.1.reasoning_content: Extra inputs are not permitted')).toBe(true);
    expect(isReasoningContentRejection('Unrecognized request argument supplied: reasoning_content')).toBe(true);
    expect(isReasoningContentRejection('reasoning_content is missing in assistant tool call message')).toBe(false);
    expect(isReasoningContentRejection('invalid request: reasoning_content is required when thinking is enabled')).toBe(false);
    const stripped = stripReasoningContent(HISTORY);
    expect(stripped[1]).not.toHaveProperty('reasoning_content');
    expect(HISTORY[1]).toHaveProperty('reasoning_content'); // input untouched
  });
});
