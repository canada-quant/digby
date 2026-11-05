/**
 * 2026-09-27 seat/provider limits — reasoning-effort HYGIENE + the ONE
 * reasoning_effort:'none' retry in runModelTurn (the gpt-6-astra incident:
 * "Function tools with reasoning_effort are not supported for gpt-6-astra in
 * /v1/chat/completions. To use function tools, use /v1/responses or set
 * reasoning_effort to 'none'" — even when Digby sent no effort at all, the
 * LiteLLM proxy injected one).
 *
 * Pins: (1) buildTurnPayload strips the provider-specific `thinking` switch for
 * a custom endpoint unless its registry entry says 'supported', and since
 * 2026-09-29 (owner: "max reasoning … everywhere regardless of the litellm
 * provider / endpoint") KEEPS reasoning_effort on 'auto' — only 'unsupported'
 * omits it; (2) a latched 'none' is sent
 * explicitly; (3) built-ins are untouched; (4) runModelTurn retries ONCE with
 * 'none' on the exact 400, latches it, and sends 'none' directly afterwards;
 * (5) no retry when latched already / built-in / other 400s;
 * (6) drainAxiosErrorBody caches the drained text on the error.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

import axios from 'axios';
import {
  buildTurnPayload, applyReasoningEffortHygiene, runModelTurn, drainAxiosErrorBody,
  latchReasoningEffortNone, reasoningEffortNoneLatched, __resetReasoningEffortLatchForTests,
  capToolsForProvider, ProviderConfig,
  nextReasoningEffortAfterRejection, reasoningEffortLatch, latchReasoningEffort,
} from './coding-model';
import { __resetLearnedToolLimitsForTests } from './provider-limits';

const mockPost = (axios as any).post as jest.Mock;

const EFFORT_400 = "litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const CUSTOM: ProviderConfig = { url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'sk-cql', model: 'api-openai-gpt-6-astra', label: 'cql-litellm (custom endpoint)', extra: { reasoning_effort: 'high', thinking: { type: 'enabled' } }, reasoningEffort: 'auto' };
const BUILTIN: ProviderConfig = { url: 'https://api.z.ai/api/paas/v4/chat/completions', apiKey: 'k', model: 'glm-5.3', label: 'ZAI direct', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } };
const tool = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) } });
const okStream = () => ({ data: Readable.from(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']) });
const msgs = [{ role: 'user', content: 'hi' }];

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningEffortLatchForTests();
  __resetLearnedToolLimitsForTests();
  delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX;
});

describe('buildTurnPayload / applyReasoningEffortHygiene', () => {
  it('keeps reasoning_effort on auto (2026-09-29), strips thinking; omits effort on unsupported; keeps both on supported', () => {
    const p = buildTurnPayload(CUSTOM, msgs, [tool('read_file')]);
    expect(p.reasoning_effort).toBe('high');
    expect(p).not.toHaveProperty('thinking');
    expect(p.tools).toHaveLength(1);
    expect(p.tool_choice).toBe('auto');
    expect(buildTurnPayload({ ...CUSTOM, reasoningEffort: 'unsupported' }, msgs, undefined)).not.toHaveProperty('reasoning_effort');
    const kept = buildTurnPayload({ ...CUSTOM, reasoningEffort: 'supported' }, msgs, undefined);
    expect(kept.reasoning_effort).toBe('high');
    expect(kept.thinking).toEqual({ type: 'enabled' });
  });
  it('a latched none is sent explicitly (even when the entry says supported); built-ins are untouched', () => {
    latchReasoningEffortNone(CUSTOM);
    expect(buildTurnPayload(CUSTOM, msgs, undefined).reasoning_effort).toBe('none');
    const supported = buildTurnPayload({ ...CUSTOM, reasoningEffort: 'supported' }, msgs, undefined);
    expect(supported.reasoning_effort).toBe('none');
    expect(supported).not.toHaveProperty('thinking');
    const b = buildTurnPayload(BUILTIN, msgs, undefined);
    expect(b.reasoning_effort).toBe('max');
    expect(b.thinking).toEqual({ type: 'enabled' });
    const payload: Record<string, any> = { reasoning_effort: 'x' };
    applyReasoningEffortHygiene(BUILTIN, payload);
    expect(payload.reasoning_effort).toBe('x');
  });
  it('caps the tool list for a custom endpoint ONLY through a known cap (no blanket default since 2026-09-27 late; a specific cap wins; the env blanket is opt-in)', () => {
    const many = Array.from({ length: 195 }, (_, i) => tool(`t_${i}`));
    expect(buildTurnPayload(CUSTOM, msgs, many).tools).toHaveLength(195);            // no known cap ⇒ unlimited
    expect(buildTurnPayload({ ...CUSTOM, maxTools: 40 }, msgs, many).tools).toHaveLength(40);
    expect(buildTurnPayload(BUILTIN, msgs, many).tools).toHaveLength(195);
    expect(capToolsForProvider(CUSTOM, many)).toBe(many);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '128';
    expect(capToolsForProvider(CUSTOM, many)).toHaveLength(128);                       // opt-in blanket
  });
});

describe('runModelTurn — the reasoning_effort:"none" retry', () => {
  it('retries ONCE with reasoning_effort:none on the exact 400, latches the model, and sends none directly on the next turn', async () => {
    mockPost.mockRejectedValueOnce(http400(EFFORT_400)).mockResolvedValueOnce(okStream());
    const r = await runModelTurn(CUSTOM, msgs, [tool('read_file')], {});
    expect(r.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][1].reasoning_effort).toBe('high'); // 2026-09-29: the seat's effort is sent (no longer stripped)
    expect(mockPost.mock.calls[1][1].reasoning_effort).toBe('none');
    expect(mockPost.mock.calls[1][1]).not.toHaveProperty('thinking');
    expect(reasoningEffortNoneLatched(CUSTOM)).toBe(true);
    mockPost.mockResolvedValueOnce(okStream());
    await runModelTurn(CUSTOM, msgs, [tool('read_file')], {});
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockPost.mock.calls[2][1].reasoning_effort).toBe('none'); // latched — no rejected round trip
  });
  it('when the none retry fails too, the retry error propagates with its body drained (the agent loop then latches the seat)', async () => {
    const second = http400('still no');
    mockPost.mockRejectedValueOnce(http400(EFFORT_400)).mockRejectedValueOnce(second);
    await expect(runModelTurn(CUSTOM, msgs, [tool('read_file')], {})).rejects.toBe(second);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(typeof (second as any).digbyBody).toBe('string');
    expect((second as any).digbyBody).toContain('still no');
  });
  it('no retry when already latched (the none payload itself failed), for a built-in, or for another 400', async () => {
    latchReasoningEffortNone(CUSTOM);
    mockPost.mockRejectedValueOnce(http400(EFFORT_400));
    await expect(runModelTurn(CUSTOM, msgs, [tool('read_file')], {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(1);
    __resetReasoningEffortLatchForTests();
    mockPost.mockRejectedValueOnce(http400(EFFORT_400));
    await expect(runModelTurn(BUILTIN, msgs, [tool('read_file')], {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(2);
    mockPost.mockRejectedValueOnce(http400("Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 195."));
    await expect(runModelTurn(CUSTOM, msgs, [tool('read_file')], {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(3);
  });
});

describe('drainAxiosErrorBody', () => {
  it('drains a streamed body once, caches it on the error, and tolerates string / object / empty data', async () => {
    const err = http400('hello');
    const a = await drainAxiosErrorBody(err);
    expect(a).toContain('hello');
    expect(await drainAxiosErrorBody(err)).toBe(a); // cached — the stream is not read twice
    expect(await drainAxiosErrorBody({ response: { data: 'plain' } })).toBe('plain');
    expect(await drainAxiosErrorBody({ response: { data: { error: { message: 'obj' } } } })).toContain('obj');
    expect(await drainAxiosErrorBody({})).toBe('');
    expect(await drainAxiosErrorBody(null)).toBe('');
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __resetToolTrimNoticeForTests } = require('./coding-model');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockedLogger = require('../../../utils/logger').default;

describe('buildTurnPayload tool-cap trim log (telemetry-noise audit PE-07: 161 warn rows / 2 h on the cql-litellm seats — the trim is designed behaviour)', () => {
  beforeEach(() => { __resetToolTrimNoticeForTests(); process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '2'; });
  afterEach(() => { delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX; });

  it('logs the trim at info ONCE per (endpoint, model) per process, never at warn, and still trims every turn', () => {
    const tools = [tool('a'), tool('b'), tool('c'), tool('d')];
    const p1 = buildTurnPayload(CUSTOM, msgs, tools);
    const p2 = buildTurnPayload(CUSTOM, msgs, tools);
    const p3 = buildTurnPayload({ ...CUSTOM, model: 'api-openai-gpt-6-luna' }, msgs, tools);
    expect(p1.tools).toHaveLength(2);
    expect(p2.tools).toHaveLength(2);
    expect(p3.tools).toHaveLength(2);
    const trimLines = (mockedLogger.info as jest.Mock).mock.calls.filter((c: any[]) => /tools trimmed/.test(String(c[0])));
    expect(trimLines).toHaveLength(2); // one per model — the second turn on the same model is silent
    expect(String(trimLines[0][0])).toContain('logged once per model per process');
    expect((mockedLogger.warn as jest.Mock).mock.calls.filter((c: any[]) => /tools trimmed/.test(String(c[0])))).toHaveLength(0);
  });

  it('an untrimmed turn logs nothing', () => {
    buildTurnPayload(CUSTOM, msgs, [tool('a')]);
    expect((mockedLogger.info as jest.Mock).mock.calls.filter((c: any[]) => /tools trimmed/.test(String(c[0])))).toHaveLength(0);
  });
});


// ── 2026-09-29: max effort everywhere + the value ladder ─────────────────────
describe('nextReasoningEffortAfterRejection (live provider phrasings)', () => {
  it.each([
    ['max', "litellm.BadRequestError: Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", 'none'],
    ['xhigh', 'This model always engages in thinking and cannot be disabled; please use low, high, or max', 'high'],
    ['max', "Invalid value: 'max'. Supported values are: 'low', 'medium', and 'high'.", 'high'],
    ['max', 'reasoning_effort: invalid value', 'xhigh'],
    ['high', 'Unrecognized request argument supplied: reasoning_effort', 'omit'],
    [undefined, "use /v1/responses or set reasoning_effort to 'none'", 'none'],
  ])('sent %s, %s → %s', (sent, detail, want) => {
    expect(nextReasoningEffortAfterRejection(sent as any, detail)).toBe(want);
  });
  it('not an effort rejection, an already-none effort-with-tools refusal, or nothing sent to lower → null', () => {
    expect(nextReasoningEffortAfterRejection('max', 'messages parameter is illegal')).toBeNull();
    expect(nextReasoningEffortAfterRejection('none', "set reasoning_effort to 'none'")).toBeNull();
    expect(nextReasoningEffortAfterRejection(undefined, 'reasoning_effort: invalid value')).toBeNull();
    expect(nextReasoningEffortAfterRejection('max', '')).toBeNull();
  });
});

describe('runModelTurn — the effort value ladder', () => {
  const MAXED: ProviderConfig = { ...CUSTOM, model: 'api-openai-gpt-6-luna', extra: { reasoning_effort: 'max' } };
  it('a rejected value retries ONCE at the highest level the error names, latches it, and later turns are capped there', async () => {
    mockPost.mockRejectedValueOnce(http400("Invalid value: 'max'. Supported values are: 'low', 'medium', and 'high'.")).mockResolvedValueOnce(okStream());
    const r = await runModelTurn(MAXED, msgs, undefined, {});
    expect(r.content).toBe('OK');
    expect(mockPost.mock.calls[0][1].reasoning_effort).toBe('max');
    expect(mockPost.mock.calls[1][1].reasoning_effort).toBe('high');
    expect(reasoningEffortLatch(MAXED)).toBe('high');
    expect(buildTurnPayload(MAXED, msgs, undefined).reasoning_effort).toBe('high');
    // a caller's own LOWER pick (a bounded capability seat) is never raised
    expect(buildTurnPayload({ ...MAXED, extra: { reasoning_effort: 'low' } }, msgs, undefined).reasoning_effort).toBe('low');
  });
  it('an unknown-parameter 400 latches omit: the effort is no longer sent', async () => {
    mockPost.mockRejectedValueOnce(http400('Unrecognized request argument supplied: reasoning_effort')).mockResolvedValueOnce(okStream());
    await runModelTurn(MAXED, msgs, undefined, {});
    expect(mockPost.mock.calls[1][1]).not.toHaveProperty('reasoning_effort');
    expect(buildTurnPayload(MAXED, msgs, undefined)).not.toHaveProperty('reasoning_effort');
  });
  it('built-ins never take the effort ladder (their effort contracts are pinned)', async () => {
    latchReasoningEffort(BUILTIN, 'high');
    expect(buildTurnPayload(BUILTIN, msgs, undefined).reasoning_effort).toBe('max');
    mockPost.mockRejectedValueOnce(http400('reasoning_effort: invalid value'));
    await expect(runModelTurn(BUILTIN, msgs, undefined, {})).rejects.toBeTruthy();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('runModelTurn — an OpenAI-class model behind LiteLLM (value step-down, then the with-tools refusal)', () => {
  it('max → high → none in ONE turn, never surfacing a 400 to the agent loop', async () => {
    const LUNA: ProviderConfig = { ...CUSTOM, model: 'api-openai-gpt-6-sol', extra: { reasoning_effort: 'max' } };
    mockPost
      .mockRejectedValueOnce(http400("Invalid value: 'max'. Supported values are: 'low', 'medium', and 'high'."))
      .mockRejectedValueOnce(http400(EFFORT_400))
      .mockResolvedValueOnce(okStream());
    const r = await runModelTurn(LUNA, msgs, [tool('read_file')], {});
    expect(r.content).toBe('OK');
    expect(mockPost.mock.calls.map((c: any[]) => c[1].reasoning_effort)).toEqual(['max', 'high', 'none']);
    expect(reasoningEffortLatch(LUNA)).toBe('none');
  });
});
