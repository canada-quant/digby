/**
 * helper-completion.ts — the shared NON-STREAMING path for the Helper/Utility
 * seats (owner report 2026-09-08: a default-thinking custom Qwen3-4B on the
 * Helper seat returned EMPTY digests that were served as success).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

import axios from 'axios';
import {
  extractNonStreamingAnswer, postNonStreamingCompletion, runHelperCompletion,
  HelperEmptyAnswerError, __resetThinkingOffLatchForTests,
} from './helper-completion';
import type { ProviderConfig } from './coding-model';

const mockPost = (axios as any).post as jest.Mock;

const CUSTOM: ProviderConfig = {
  url: 'https://llm.example.com/v1/chat/completions', apiKey: 'sk-x', model: 'qwen3-4b',
  label: 'cql-litellm (custom endpoint)', extra: {},
};
const BUILT_IN: ProviderConfig = {
  url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: 'sk-d', model: 'qwen3.6-27b',
  label: 'DashScope intl (Qwen)', extra: { temperature: 0.5 },
};
// The agent-seat shape of the DeepSeek built-in (coding-model.ts): thinking ON +
// reasoning_effort max — exactly what a fast seat must NOT inherit.
const DEEPSEEK: ProviderConfig = {
  url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-ds', model: 'deepseek-flash',
  label: 'DeepSeek direct', extra: { reasoning_effort: 'max', thinking: { type: 'enabled' } },
};
const reply = (message: any, finish_reason = 'stop') => ({ data: { choices: [{ message, finish_reason }] } });
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

beforeEach(() => { mockPost.mockReset(); __resetThinkingOffLatchForTests(); });

describe('extractNonStreamingAnswer', () => {
  it('plain content passes through trimmed', () => {
    expect(extractNonStreamingAnswer({ message: { content: '  Digest here. ' }, finish_reason: 'stop' }))
      .toEqual({ text: 'Digest here.', hadReasoning: false, finishReason: 'stop' });
  });
  it('strips a CLOSED leading <think> block and flags reasoning', () => {
    expect(extractNonStreamingAnswer({ message: { content: '<think>hmm</think>\nAnswer' } }))
      .toMatchObject({ text: 'Answer', hadReasoning: true });
  });
  it('an UNCLOSED <think> block (budget ran out mid-thought) is NOT prose — text is empty', () => {
    expect(extractNonStreamingAnswer({ message: { content: '<think>Okay, the user wants me to digest…' }, finish_reason: 'length' }))
      .toEqual({ text: '', hadReasoning: true, finishReason: 'length' });
  });
  it('reasoning_content with empty content → empty text, reasoning flagged (vLLM reasoning parser on)', () => {
    expect(extractNonStreamingAnswer({ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }))
      .toEqual({ text: '', hadReasoning: true, finishReason: 'length' });
  });
  it('tolerates a missing choice', () => {
    expect(extractNonStreamingAnswer(undefined)).toEqual({ text: '', hadReasoning: false, finishReason: null });
  });
});

describe('postNonStreamingCompletion — thinking-off directive', () => {
  it('CUSTOM endpoints get chat_template_kwargs.enable_thinking=false; built-ins are sent untouched', async () => {
    mockPost.mockResolvedValue(reply({ content: 'OK' }));
    await postNonStreamingCompletion(CUSTOM, { model: 'qwen3-4b', messages: [] }, { timeout: 1000 });
    expect(mockPost.mock.calls[0][1]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    await postNonStreamingCompletion(BUILT_IN, { model: 'qwen3.6-27b', messages: [] }, { timeout: 1000 });
    expect('chat_template_kwargs' in mockPost.mock.calls[1][1]).toBe(false);
  });

  it('DeepSeek built-ins get the vendor thinking-off switch and lose the spread-in reasoning_effort (V4.1 Flash thinks by default)', async () => {
    mockPost.mockResolvedValue(reply({ content: 'OK' }));
    await postNonStreamingCompletion(DEEPSEEK, { model: 'deepseek-flash', messages: [], max_tokens: 512, ...DEEPSEEK.extra }, { timeout: 1000 });
    const sent = mockPost.mock.calls[0][1];
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in sent).toBe(false);
    expect(sent.max_tokens).toBe(512);
    // Not the vLLM directive — DeepSeek has its own switch.
    expect('chat_template_kwargs' in sent).toBe(false);
    // Exactly one POST: no retry dance for a built-in.
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('keepThinking preserves the seat extras (reflection wants the reasoning); a DeepSeek CUSTOM endpoint is not treated as the built-in', async () => {
    mockPost.mockResolvedValue(reply({ content: 'OK' }));
    await postNonStreamingCompletion(DEEPSEEK, { model: 'deepseek-flash', messages: [], ...DEEPSEEK.extra }, { timeout: 1000, keepThinking: true });
    expect(mockPost.mock.calls[0][1]).toMatchObject({ reasoning_effort: 'max', thinking: { type: 'enabled' } });
    const customDeepSeek: ProviderConfig = { ...DEEPSEEK, label: 'my-proxy (custom endpoint)', extra: {} };
    await postNonStreamingCompletion(customDeepSeek, { model: 'deepseek-flash', messages: [] }, { timeout: 1000 });
    // Custom-endpoint path: the vLLM-style directive, not the DeepSeek switch.
    expect(mockPost.mock.calls[1][1]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect('thinking' in mockPost.mock.calls[1][1]).toBe(false);
  });

  it('a 4xx on the directive retries WITHOUT it once and latches off for that model', async () => {
    mockPost.mockRejectedValueOnce(http(400)).mockResolvedValue(reply({ content: 'OK' }));
    await postNonStreamingCompletion(CUSTOM, { model: 'qwen3-4b', messages: [] }, { timeout: 1000 });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect('chat_template_kwargs' in mockPost.mock.calls[1][1]).toBe(false);
    // Latched: the next call for the same model skips the directive entirely.
    await postNonStreamingCompletion(CUSTOM, { model: 'qwen3-4b', messages: [] }, { timeout: 1000 });
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect('chat_template_kwargs' in mockPost.mock.calls[2][1]).toBe(false);
  });

  it('a 5xx / transport error is NOT treated as a directive rejection (no retry, propagates)', async () => {
    mockPost.mockRejectedValueOnce(http(503));
    await expect(postNonStreamingCompletion(CUSTOM, { model: 'qwen3-4b', messages: [] }, { timeout: 1000 })).rejects.toThrow('HTTP 503');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('an admin-flagged "no-think" provider already carries the directive in extra — not doubled, and a 4xx surfaces', async () => {
    const flagged: ProviderConfig = { ...CUSTOM, extra: { chat_template_kwargs: { enable_thinking: false } } };
    mockPost.mockRejectedValueOnce(http(400));
    await expect(postNonStreamingCompletion(flagged, { ...flagged.extra, model: 'qwen3-4b', messages: [] }, { timeout: 1000 })).rejects.toThrow('HTTP 400');
    expect(mockPost).toHaveBeenCalledTimes(1); // the admin asked for it explicitly — honest failure, no silent drop
  });

  it('keyless custom endpoints send NO Authorization header', async () => {
    mockPost.mockResolvedValue(reply({ content: 'OK' }));
    await postNonStreamingCompletion({ ...CUSTOM, apiKey: undefined }, { model: 'qwen3-4b', messages: [] }, { timeout: 1000 });
    expect(mockPost.mock.calls[0][2].headers.Authorization).toBeUndefined();
  });
});

describe('runHelperCompletion', () => {
  it('returns the extracted answer with the seat payload contract (extras first, caller params win, omitParams stripped)', async () => {
    mockPost.mockResolvedValue(reply({ content: '<think>x</think>The digest' }));
    const p: ProviderConfig = { ...BUILT_IN, extra: { temperature: 0.9, max_tokens: 5 }, omitParams: ['stream_options'] };
    const ans = await runHelperCompletion(p, [{ role: 'user', content: 'go' }], { maxTokens: 1400, temperature: 0.3, timeoutMs: 60_000 });
    expect(ans.text).toBe('The digest');
    expect(mockPost.mock.calls[0][1]).toMatchObject({ model: 'qwen3.6-27b', max_tokens: 1400, temperature: 0.3 });
    expect(mockPost.mock.calls[0][2]).toMatchObject({ timeout: 60_000 });
  });

  it('EMPTY answer THROWS HelperEmptyAnswerError naming the model and the fix (the blank-digest bug)', async () => {
    mockPost.mockResolvedValue(reply({ content: '', reasoning_content: 'long chain of thought' }, 'length'));
    const err = await runHelperCompletion(CUSTOM, [{ role: 'user', content: 'go' }], { maxTokens: 1400, timeoutMs: 1000 }).catch(e => e);
    expect(err).toBeInstanceOf(HelperEmptyAnswerError);
    expect(err.message).toContain('qwen3-4b');
    expect(err.message).toContain('spent the budget thinking');
    expect(err.message).toContain('finish_reason=length');
    expect(err.message).toContain('"no-think"');
  });

  it('an unclosed <think> digest is treated as empty, not served as prose', async () => {
    mockPost.mockResolvedValue(reply({ content: '<think>Okay so the sources say' }, 'length'));
    await expect(runHelperCompletion(CUSTOM, [{ role: 'user', content: 'go' }], { maxTokens: 1400, timeoutMs: 1000 }))
      .rejects.toBeInstanceOf(HelperEmptyAnswerError);
  });
});

describe('2026-09-29 — the agent seats\' max effort never rides a bounded custom-endpoint seat', () => {
  it('reasoning_effort is dropped on both the thinking-off attempt and the fallback; keepThinking keeps it', async () => {
    mockPost.mockRejectedValueOnce(http(400)).mockResolvedValueOnce(reply({ content: 'OK' }));
    await postNonStreamingCompletion(CUSTOM, { model: 'qwen3-4b', messages: [], reasoning_effort: 'max', max_tokens: 64 }, { timeout: 1000 });
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('reasoning_effort');
    expect(mockPost.mock.calls[0][1]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(mockPost.mock.calls[1][1]).not.toHaveProperty('reasoning_effort');
    mockPost.mockResolvedValueOnce(reply({ content: 'OK' }));
    await postNonStreamingCompletion({ ...CUSTOM, model: 'qwen3-8b' }, { model: 'qwen3-8b', messages: [], reasoning_effort: 'max' }, { timeout: 1000, keepThinking: true });
    expect(mockPost.mock.calls[2][1].reasoning_effort).toBe('max');
  });
});
