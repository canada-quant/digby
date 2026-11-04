/**
 * Replay pin — log-signal ticket 4c691bfe (2026-10-28, this lane's lead
 * member; 170 rows / 24 h across 8 distinct hours).
 *
 * THE FINGERPRINT: "vision_describe seat: tt-qwen3.8-flash-next (llm-cql
 * (custom endpoint)) failed — HTTP 400 — litellm.BadRequestError:
 * OpenAIException - reasoning_effort must be one of ('minimal', 'low',
 * 'medium', 'high', 'xhigh'), got 'max'".
 *
 * ADJUDICATION (this lane, 2026-10-29): a GENUINE framework defect, not
 * designed observability. The owner's 2026-09-29 wave sends
 * `reasoning_effort:'max'` on every custom-endpoint provider
 * (coding-model.ts `customEndpointEffortExtra`). The STREAMED path
 * (runModelTurn) catches the resulting 400 and steps DOWN the value ladder,
 * latching the accepted rung per (endpoint, model) — so a strict backend costs
 * one rejection per process. The NON-STREAMING seat path had no ladder at all:
 * `postNonStreamingCompletion` only DROPPED the key for bounded seats, and
 * `seatCompletion` re-added the provider extra verbatim for every
 * keepThinking seat (Image reader, frontier council, reflection). The result
 * was a standing failure class: EVERY `tt-qwen3.8-flash-next` vision call paid
 * the identical 400 forever, with no latch to stop it — exactly the
 * "suppression state lost / standing failure class" shape the sweep exists to
 * find, and why the class could never fall below the sweep's ≤2 bar.
 *
 * THE PIN asserts the three properties a future pass must not regress:
 *   (a) the pure classifier the streamed path uses resolves this EXACT prod
 *       body to a lower rung ('xhigh') — one implementation, never a copy;
 *   (b) a non-streaming custom-endpoint call that hits that 400 RETRIES and
 *       RESOLVES (the call no longer dies), sending the accepted rung;
 *   (c) the rung is LATCHED, so the NEXT call sends it from the start and
 *       pays no second rejection (the fix's whole point — a per-process, not
 *       per-call, rejection).
 */

import axios from 'axios';
import {
  postNonStreamingCompletion,
} from './helper-completion';
import {
  latchReasoningEffort, nextReasoningEffortAfterRejection, reasoningEffortLatch,
  __resetThinkingBudgetLatchForTests, __resetReasoningEffortLatchForTests,
} from './coding-model';

jest.mock('axios');
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const post = axios.post as jest.Mock;

/** The verbatim prod rejection body (ticket 4c691bfe, newest row at filing). */
const PROD_400 = "litellm.BadRequestError: OpenAIException - reasoning_effort must be one of ('minimal', 'low', 'medium', 'high', 'xhigh'), got 'max'No fallback model group found for original model_group=tt-qwen3.8-flash-next.";

function http400(detail: string) {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { error: { message: detail } } },
  });
}

function ok() {
  return { data: { choices: [{ message: { content: 'a description' }, finish_reason: 'stop' }] } };
}

/** The Image reader seat's provider shape for the failing spec. */
const PROVIDER: any = {
  url: 'https://llm-cql.example/v1/chat/completions',
  apiKey: 'test-key',
  model: 'tt-qwen3.8-flash-next',
  label: 'llm-cql (custom endpoint)',
  // The owner's 2026-09-29 wave: every custom endpoint carries effort 'max'.
  extra: { max_tokens: 131072, reasoning_effort: 'max' },
  reasoningEffort: 'auto',
  supportsVision: true,
};

beforeEach(() => {
  post.mockReset();
  __resetThinkingBudgetLatchForTests();
  __resetReasoningEffortLatchForTests();
});

describe('ticket 4c691bfe — non-streaming seats ladder a rejected reasoning_effort', () => {
  it('(a) the shared classifier resolves the verbatim prod body to a lower rung', () => {
    // The prod body names the allowed set and says what was sent ('max').
    // 'xhigh' is the highest named level BELOW 'max' on the ladder.
    expect(nextReasoningEffortAfterRejection('max', PROD_400)).toBe('xhigh');
    // A body that names nothing usable must NOT silently invent a value.
    expect(nextReasoningEffortAfterRejection(undefined, PROD_400)).toBeNull();
  });

  it('(b) a 400 on reasoning_effort is retried and the call RESOLVES instead of dying', async () => {
    post
      .mockRejectedValueOnce(http400(PROD_400))
      .mockResolvedValueOnce(ok());

    // keepThinking:true is the Image reader / council / reflection shape —
    // the one that used to send 'max' verbatim on every single call.
    const res = await postNonStreamingCompletion(
      PROVIDER,
      { model: PROVIDER.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4000, reasoning_effort: 'max' },
      { timeout: 5_000, keepThinking: true },
    );

    expect(res.data.choices[0].message.content).toBe('a description');
    expect(post).toHaveBeenCalledTimes(2);
    // The retry sent the ACCEPTED rung, not the rejected one.
    const retryBody = post.mock.calls[1][1];
    expect(retryBody.reasoning_effort).toBe('xhigh');
    expect(retryBody.reasoning_effort).not.toBe('max');
  });

  it('(c) the accepted rung is LATCHED — the next call starts there and pays no rejection', async () => {
    post
      .mockRejectedValueOnce(http400(PROD_400))
      .mockResolvedValueOnce(ok());

    await postNonStreamingCompletion(
      PROVIDER,
      { model: PROVIDER.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4000, reasoning_effort: 'max' },
      { timeout: 5_000, keepThinking: true },
    );
    expect(reasoningEffortLatch(PROVIDER)).toBe('xhigh');

    post.mockReset();
    post.mockResolvedValueOnce(ok());
    await postNonStreamingCompletion(
      PROVIDER,
      { model: PROVIDER.model, messages: [{ role: 'user', content: 'second call' }], max_tokens: 4000, reasoning_effort: 'max' },
      { timeout: 5_000, keepThinking: true },
    );

    // ONE call, no rejection paid, and it carried the latched rung.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].reasoning_effort).toBe('xhigh');
  });

  it('a non-effort 400 is NOT swallowed by the ladder (a real rejection still throws)', async () => {
    post.mockRejectedValue(http400('messages[0].content must be a string'));
    await expect(postNonStreamingCompletion(
      PROVIDER,
      { model: PROVIDER.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4000, reasoning_effort: 'max' },
      { timeout: 5_000, keepThinking: true },
    )).rejects.toThrow(/400/);
  });

  it('a 5xx is NOT retried by the ladder (it has its own lanes)', async () => {
    post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 502, data: { error: { message: PROD_400 } } } }));
    await expect(postNonStreamingCompletion(
      PROVIDER,
      { model: PROVIDER.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4000, reasoning_effort: 'max' },
      { timeout: 5_000, keepThinking: true },
    )).rejects.toThrow(/boom/);
    expect(post.mock.calls.every((c) => c[1].reasoning_effort !== 'xhigh')).toBe(true);
  });
});