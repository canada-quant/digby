/**
 * SYSTEM-FIRST end-to-end request shape — ticket 68167bbf, 2026-10-28.
 *
 * REPLAYS THE EXACT FAILING WIRE SHAPE from production:
 *   fingerprint [tt-qwen3.8-flash-next] tools=51: system:53440 user:2407 system:265
 * and the provider's verbatim rejection:
 *   litellm.BadRequestError: OpenAIException - messages[2].role is system;
 *   the system message must be first
 *
 * Three behaviours are pinned here, on the REAL runModelTurn:
 *   1. FIRST rejection of the order: runModelTurn merges every system message
 *      into ONE leading block, re-posts a DIFFERENT request, and returns 200 —
 *      the user-facing promise of acceptance criterion 1.
 *   2. The merge is LATERNED for the (endpoint, model), so a LATER turn sends
 *      the system-first shape on its FIRST post — no second rejection, ever.
 *   3. A 400 that is NOT about message order is never healed by this path
 *      (the classifier's acquittals are pinned in system-first.test.ts; here we
 *      prove the retry count stays at 1 for an unrelated 400 so the existing
 *      lanes keep owning it).
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
import { runModelTurn, __resetReasoningEffortLatchForTests, type ProviderConfig } from './coding-model';
import { __resetSystemFirstLatchForTests, systemFirstLatched } from './system-first';

const mockPost = (axios as any).post as jest.Mock;

/** The strict backend: vLLM on the Quietbox, fronted by LiteLLM. */
const TT_SEAT: ProviderConfig = {
  url: 'https://llm.cql.ca/v1/chat/completions',
  apiKey: 'sk-test',
  model: 'tt-qwen3.8-flash-next',
  spec: 'cql-litellm:tt-qwen3.8-flash-next',
  label: 'cql-litellm (custom endpoint)',
  extra: {},
  reasoningEffort: 'auto',
};

/** The VERBATIM provider rejection (drained JSON body on a 400). */
const systemOrder400 = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: Readable.from([JSON.stringify({
      error: { message: 'litellm.BadRequestError: OpenAIException - messages[2].role is system; the system message must be first' },
    })]),
  },
});

/** An unrelated 400 (the size class) — must NOT be healed here. */
const size400 = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: Readable.from([JSON.stringify({ error: { message: 'request exceeds the maximum context length allowed' } })]),
  },
});

const okStream = () => ({
  data: Readable.from([
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]),
});

/** THE INCIDENT SHAPE: 53,440-char doctrine, 2,407-char user task, 265-char clock note. */
const incidentMessages = () => [
  { role: 'system', content: 'D'.repeat(53_440) },
  { role: 'user', content: 'U'.repeat(2_407) },
  { role: 'system', content: '[HARNESS CLOCK — not typed by the user] ' + 'C'.repeat(265 - 42) },
];

const rolesOf = (payload: any): string[] => (payload?.messages ?? []).map((m: any) => m.role);

beforeEach(() => {
  jest.clearAllMocks();
  __resetSystemFirstLatchForTests();
  __resetReasoningEffortLatchForTests();
  delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
});
afterAll(() => {
  delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
});

describe('runModelTurn — the tt-qwen3.8-flash-next system-order 400 (ticket 68167bbf)', () => {
  it('REPLAY: the exact failing shape returns 200 after ONE shape-changing retry (never a byte-identical re-send)', async () => {
    mockPost
      .mockRejectedValueOnce(systemOrder400())  // the first post: the incident rejection
      .mockResolvedValueOnce(okStream());       // the healed post: 200

    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(turn.content).toBe('OK');       // the turn SUCCEEDS — acceptance criterion 1
    expect(turn.finishReason).toBe('stop');
    expect(mockPost).toHaveBeenCalledTimes(2); // exactly ONE corrective retry

    // The FIRST post carried the broken order (that is why it was rejected)…
    const first: any = mockPost.mock.calls[0][1];
    expect(rolesOf(first)).toEqual(['system', 'user', 'system']);
    expect(first.messages[2].content).toContain('[HARNESS CLOCK');

    // …and the RETRY is a DIFFERENT request: ONE leading system message, the
    // user turn preserved, and it is not the same object/array.
    const second: any = mockPost.mock.calls[1][1];
    expect(rolesOf(second)).toEqual(['system', 'user']);
    expect(second.messages).not.toBe(first.messages);
    // Content preserved in document order — nothing lost, nothing reordered
    // beyond the required hoist.
    expect(second.messages[0].content.startsWith('D'.repeat(100))).toBe(true);
    expect(second.messages[0].content).toContain('[HARNESS CLOCK');
    expect(second.messages[1].content).toBe('U'.repeat(2_407));

    // The strictness was learned for this seat, and telemetered once.
    expect(systemFirstLatched(TT_SEAT)).toBe(true);
    const metrics = mockRecordLoopMetric.mock.calls.map((c) => c[0]);
    const replay = metrics.find((m) => m?.kind === 'system_first_replay');
    expect(replay?.meta?.outcome).toBe('rejected_latched');
    expect(replay?.meta?.model).toBe('tt-qwen3.8-flash-next');
    expect(replay?.meta?.systemCount).toBe(2);
  });

  it('the NEXT turn on the latched seat sends the system-first shape on its FIRST post (the rejection is never paid twice)', async () => {
    // Turn 1 teaches the seat.
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
    expect(mockPost).toHaveBeenCalledTimes(2);

    // Turn 2: a clean slate on the mock, same seat, same broken input shape.
    mockPost.mockReset();
    mockPost.mockResolvedValueOnce(okStream());
    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(turn.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(1); // ONE post — no rejection, no retry
    const body: any = mockPost.mock.calls[0][1];
    expect(rolesOf(body)).toEqual(['system', 'user']); // already normalized pre-dispatch
  });

  it('the normalization is PER SEAT: another model on the same endpoint still sends its original shape', async () => {
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
    expect(systemFirstLatched(TT_SEAT)).toBe(true);

    mockPost.mockReset();
    mockPost.mockResolvedValueOnce(okStream());
    const other: ProviderConfig = { ...TT_SEAT, model: 'tt-qwen3.8-27b', spec: 'cql-litellm:tt-qwen3.8-27b' };
    await runModelTurn(other, incidentMessages(), undefined, {});

    const body: any = mockPost.mock.calls[0][1];
    // Un-normalized: the trailing system note is still where the loop put it.
    expect(rolesOf(body)).toEqual(['system', 'user', 'system']);
  });

  it('an UNRELATED 400 is never healed by this path — exactly ONE post, and the error propagates to the existing lanes', async () => {
    mockPost.mockRejectedValueOnce(size400());

    await expect(runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(mockPost).toHaveBeenCalledTimes(1); // no corrective retry for the size class
    expect(systemFirstLatched(TT_SEAT)).toBe(false); // the latch is untouched
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).some((m) => m?.kind === 'system_first_replay')).toBe(false);
  });

  it('a legal (already system-first) transcript is sent ONCE, byte-identical, and never latches', async () => {
    mockPost.mockResolvedValueOnce(okStream());
    const messages = [
      { role: 'system', content: 'doctrine' },
      { role: 'user', content: 'go' },
    ];
    const turn = await runModelTurn(TT_SEAT, messages, undefined, {});
    expect(turn.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user']);
    expect(systemFirstLatched(TT_SEAT)).toBe(false);
  });

  it('a SECOND system-order 400 in the SAME turn (the backend rejects even the merged shape) surfaces, never loops', async () => {
    mockPost
      .mockRejectedValueOnce(systemOrder400())
      .mockRejectedValueOnce(systemOrder400());

    await expect(runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).rejects.toMatchObject({
      response: { status: 400 },
    });
    // Bounded: the healing retry is once per turn — the agent loop's fast-fail
    // lane (message_order) owns this shape from here (agent.ts).
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('kill switch SYSTEM_FIRST_NORMALIZE_DISABLED=1: a latched seat sends its original shape again (normalization off)', async () => {
    // Latch first (normal path).
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
    expect(systemFirstLatched(TT_SEAT)).toBe(true);

    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '1';
    mockPost.mockReset();
    mockPost.mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user', 'system']);
  });

  it('kill switch also disables the CORRECTIVE RETRY (a true revert: the 400 propagates, no heal attempted)', async () => {
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '1';
    mockPost.mockRejectedValueOnce(systemOrder400());

    await expect(runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(mockPost).toHaveBeenCalledTimes(1); // no second post, no latch
    expect(systemFirstLatched(TT_SEAT)).toBe(false);
  });

  // ── BLAST RADIUS: a NON-strict backend (the overwhelming majority of traffic
  //    — Moonshot / ZAI / DeepSeek) must be byte-identical to before this
  //    change. Moonshot prefix caching in particular depends on the leading
  //    system block being the run's byte-stable prefix head, so a speculative
  //    hoist would silently destroy the K3 cache hit rate on every turn.
  it('NO-OP for a non-latched seat: identical messages, identical prompt_cache_key', async () => {
    const MOONSHOT: ProviderConfig = {
      url: 'https://api.moonshot.ai/v1/chat/completions',
      apiKey: 'k',
      model: 'kimi-k3',
      label: 'Moonshot direct',
      extra: {},
    };
    mockPost.mockResolvedValueOnce(okStream());
    const messages = incidentMessages();
    await runModelTurn(MOONSHOT, messages, undefined, {});

    expect(mockPost).toHaveBeenCalledTimes(1);
    const body: any = mockPost.mock.calls[0][1];
    // The trailing clock note is STILL trailing — nothing was hoisted.
    expect(rolesOf(body)).toEqual(['system', 'user', 'system']);
    expect(body.messages[2].content).toContain('[HARNESS CLOCK');

    // The cache key is derived from the transcript's first system message;
    // it must still be derived from the SAME array the caller passed.
    const { deriveCacheKey } = jest.requireActual('./moonshot-cache');
    expect(body.prompt_cache_key).toBe(deriveCacheKey('kimi-k3', body.messages));
    expect(systemFirstLatched(MOONSHOT)).toBe(false);
  });
});