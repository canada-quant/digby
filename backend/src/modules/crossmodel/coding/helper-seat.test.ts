/**
 * helper-seat.ts — the coding_helper seat HEALTH fallback (owner 2026-09-14:
 * the custom cql spark qwen4b helper seat 400'd tool-bearing worker turns and
 * timed out digests; the owner saw "banked memory is just raw search JSON").
 *
 * Pins: the failure classifier (4xx/5xx except 401/403, timeout, connection
 * codes, empty answer ⇒ fallbackable; auth + unknown ⇒ surface), the ONE
 * bounded retry on the built-in helper with an honest attribution + a
 * seat_fallback row, no fallback for built-in seats / the kill switch / a
 * keyless built-in / config errors, never a second hop, and the worker-path
 * decision (custom 4xx or connection failure ⇒ reason; 429/5xx/auth ⇒ null).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

const mockResolveRoleModel = jest.fn(async (_k: string): Promise<string> => '');
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
}));

const REG = {
  url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql',
  model: 'qwen3-4b', label: 'cql', supportsVision: false, coding: true, thinkingOff: false,
};
const mockResolveRegistryModel = jest.fn(async (spec: string) => (spec === 'cql:qwen3-4b' ? REG : null));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...(a as [string])),
}));

const mockNoteSeatFallback = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
}));

import axios from 'axios';
import logger from '../../../utils/logger';
import { leadSeatConnectionFailure, leadSeatHttpFailure, LEAD_BUILTIN_FALLBACK_ORDER,
  classifyHelperSeatFailure, runHelperSeatCompletion, workerSeatFailureReason,
  helperSeatAttributionLine, helperSeatFallbackDisabled,
} from './helper-seat';
import { HelperEmptyAnswerError, __resetThinkingOffLatchForTests } from './helper-completion';
import type { ProviderConfig } from './coding-model';

const mockPost = (axios as any).post as jest.Mock;
const mockWarn = (logger as any).warn as jest.Mock;

const reply = (content: string) => ({ data: { choices: [{ message: { content }, finish_reason: 'stop' }] } });
const http = (status: number, data?: any) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

const CUSTOM: ProviderConfig = { url: REG.url, apiKey: 'sk-x', model: 'qwen3-4b', label: 'cql (custom endpoint)', extra: {} };
const BUILT_IN: ProviderConfig = { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: 'sk-d', model: 'qwen3.6-27b', label: 'DashScope intl (Qwen)', extra: {} };

const MESSAGES = [{ role: 'user', content: 'digest this' }];
const CALL = { messages: MESSAGES, maxTokens: 1400, temperature: 0.3, timeoutMs: 60_000, caller: 'web_pipe', sessionId: 'sess-1' };

/** Model ids POSTed, in order — the custom seat's directive try + latched retry both count. */
const postedModels = () => mockPost.mock.calls.map((c) => c[1]?.model);

beforeEach(() => {
  jest.clearAllMocks();
  __resetThinkingOffLatchForTests();
  delete process.env.HELPER_SEAT_FALLBACK_DISABLED;
  process.env.DASHSCOPE_API_KEY = 'sk-dashscope';
  mockResolveRoleModel.mockResolvedValue('cql:qwen3-4b'); // the owner's override
  mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'cql:qwen3-4b' ? REG : null));
});

describe('classifyHelperSeatFailure', () => {
  it('HTTP 400 (tool-bearing / prompt-shape rejection) is fallbackable and carries the provider detail', () => {
    const f = classifyHelperSeatFailure(http(400, { error: { message: 'tools are not supported by this model' } }));
    expect(f).toMatchObject({ fallbackable: true, httpStatus: 400 });
    expect(f.reason).toContain('HTTP 400');
    expect(f.reason).toContain('tools are not supported');
  });
  it.each([401, 403])('HTTP %i is a CONFIG error — surfaced, never fallen back', (status) => {
    expect(classifyHelperSeatFailure(http(status))).toMatchObject({ fallbackable: false, httpStatus: status });
  });
  it.each([404, 413, 422, 429, 500, 502, 503])('HTTP %i is fallbackable (the seat is unhealthy right now)', (status) => {
    expect(classifyHelperSeatFailure(http(status))).toMatchObject({ fallbackable: true, httpStatus: status, reason: `HTTP ${status}` });
  });
  it('an axios timeout (ECONNABORTED / "timeout of 60000ms exceeded") → timeout', () => {
    expect(classifyHelperSeatFailure(coded('ECONNABORTED', 'timeout of 60000ms exceeded'))).toEqual({ reason: 'timeout', fallbackable: true });
    expect(classifyHelperSeatFailure(new Error('timeout of 60000ms exceeded'))).toEqual({ reason: 'timeout', fallbackable: true });
  });
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'])('%s (by code or in the message) → fallbackable, named', (code) => {
    expect(classifyHelperSeatFailure(coded(code))).toEqual({ reason: code, fallbackable: true });
    expect(classifyHelperSeatFailure(new Error(`connect ${code} 10.0.0.5:8000`))).toEqual({ reason: code, fallbackable: true });
  });
  it('an EMPTY answer (HelperEmptyAnswerError) → fallbackable "empty answer"', () => {
    const err = new HelperEmptyAnswerError(CUSTOM, { text: '', hadReasoning: true, finishReason: 'length' });
    expect(classifyHelperSeatFailure(err)).toEqual({ reason: 'empty answer', fallbackable: true });
  });
  it('an unclassified error is surfaced, not masked', () => {
    expect(classifyHelperSeatFailure(new TypeError('Cannot read properties of undefined'))).toMatchObject({ fallbackable: false });
    expect(classifyHelperSeatFailure(undefined)).toEqual({ reason: 'unknown error', fallbackable: false });
  });
});

describe('runHelperSeatCompletion — the digest path', () => {
  it('a healthy custom seat answers with NO fallback, no attribution, no metric', async () => {
    mockPost.mockResolvedValue(reply('DIGEST from the seat'));
    const r = await runHelperSeatCompletion(CALL);
    expect(r).toMatchObject({ text: 'DIGEST from the seat', model: 'cql:qwen3-4b', label: 'cql (custom endpoint)' });
    expect(r.fallback).toBeUndefined();
    expect(r.attribution).toBeUndefined();
    expect(postedModels()).toEqual(['qwen3-4b']);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  it('HTTP 400 on the custom seat → ONE retry on the built-in helper, honest attribution, seat_fallback row, one warn naming the endpoint', async () => {
    // Custom seat: the thinking-off directive try 400s, the latched retry 400s
    // too (helper-completion's contract) → the seat has failed. Built-in: OK.
    mockPost
      .mockRejectedValueOnce(http(400, { error: { message: 'tools not supported' } }))
      .mockRejectedValueOnce(http(400, { error: { message: 'tools not supported' } }))
      .mockResolvedValueOnce(reply('DIGEST from the built-in'));
    const r = await runHelperSeatCompletion(CALL);
    expect(r.text).toBe('DIGEST from the built-in');
    expect(r.model).toBe('qwen3.6-27b');             // the spec that ACTUALLY wrote it
    expect(r.label).toBe('DashScope intl (Qwen)');
    expect(r.fallback).toMatchObject({ role: 'coding_helper', from: 'cql:qwen3-4b', fromLabel: 'cql (custom endpoint)', to: 'qwen3.6-27b', status: 'recovered', httpStatus: 400 });
    expect(r.attribution).toBe(`digest via qwen3.6-27b — custom helper seat cql (custom endpoint) (cql:qwen3-4b) failed: ${r.fallback!.reason}`);
    expect(r.attribution).toContain('HTTP 400');
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3-4b', 'qwen3.6-27b']);
    // The built-in was called with the Helper contract (same messages/budget).
    expect(mockPost.mock.calls[2][1]).toMatchObject({ model: 'qwen3.6-27b', messages: MESSAGES, max_tokens: 1400, temperature: 0.3 });
    expect(mockPost.mock.calls[2][2]).toMatchObject({ timeout: 60_000, headers: { Authorization: 'Bearer sk-dashscope' } });
    expect(mockNoteSeatFallback).toHaveBeenCalledTimes(1);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_helper', from: 'cql:qwen3-4b', to: 'qwen3.6-27b', status: 'recovered', caller: 'web_pipe', httpStatus: 400, sessionId: 'sess-1',
    }));
    const seatWarns = mockWarn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('helper-seat'));
    expect(seatWarns).toHaveLength(1);
    expect(seatWarns[0]).toContain('cql (custom endpoint)');
    expect(seatWarns[0]).toContain('retrying once on the built-in qwen3.6-27b');
  });

  it('a TIMEOUT on the custom seat (the 15:56Z prod shape) falls back the same way', async () => {
    mockPost.mockRejectedValueOnce(coded('ECONNABORTED', 'timeout of 60000ms exceeded')).mockResolvedValueOnce(reply('late digest'));
    const r = await runHelperSeatCompletion(CALL);
    expect(r.text).toBe('late digest');
    expect(r.fallback).toMatchObject({ status: 'recovered', reason: 'timeout' });
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3.6-27b']); // a transport error skips the directive retry
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout', status: 'recovered' }));
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND'])('%s (the server is not there) falls back', async (code) => {
    mockPost.mockRejectedValueOnce(coded(code, `connect ${code} 10.0.0.5:8000`)).mockResolvedValueOnce(reply('ok'));
    const r = await runHelperSeatCompletion(CALL);
    expect(r.fallback).toMatchObject({ status: 'recovered', reason: code });
  });

  it('an EMPTY answer from the custom seat (default-thinking model burned the budget) falls back — the digest is never blank', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] } })
      .mockResolvedValueOnce(reply('real digest'));
    const r = await runHelperSeatCompletion(CALL);
    expect(r.text).toBe('real digest');
    expect(r.fallback).toMatchObject({ status: 'recovered', reason: 'empty answer' });
  });

  it.each([401, 403])('HTTP %i is a CONFIG error — thrown as-is, no built-in retry, no metric', async (status) => {
    mockPost.mockRejectedValueOnce(http(status)).mockRejectedValueOnce(http(status));
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow(`status code ${status}`);
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3-4b']);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  it('a BUILT-IN seat (no override) that fails has nothing to fall to — the error propagates, exactly one call class', async () => {
    mockResolveRoleModel.mockResolvedValue('');
    mockPost.mockRejectedValueOnce(http(500));
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow('status code 500');
    expect(postedModels()).toEqual(['qwen3.6-27b']);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  it('kill switch HELPER_SEAT_FALLBACK_DISABLED=1 → the custom seat error propagates untouched', async () => {
    process.env.HELPER_SEAT_FALLBACK_DISABLED = '1';
    expect(helperSeatFallbackDisabled()).toBe(true);
    mockPost.mockRejectedValueOnce(http(400)).mockRejectedValueOnce(http(400));
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow('status code 400');
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3-4b']);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  it('a KEYLESS built-in (Edge without DASHSCOPE_API_KEY) cannot serve the fallback — original error, metric status "unavailable"', async () => {
    delete process.env.DASHSCOPE_API_KEY;
    mockPost.mockRejectedValueOnce(http(400)).mockRejectedValueOnce(http(400));
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow('status code 400');
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3-4b']); // the built-in was never POSTed
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable', to: 'qwen3.6-27b' }));
  });

  it('the built-in failing too → ONE combined error naming both causes, metric status "failed", never a third hop', async () => {
    mockPost
      .mockRejectedValueOnce(http(400)).mockRejectedValueOnce(http(400))
      .mockRejectedValueOnce(http(503));
    const err = await runHelperSeatCompletion(CALL).catch((e) => e);
    expect(err.message).toContain('custom helper seat cql (custom endpoint) (cql:qwen3-4b) failed: HTTP 400');
    expect(err.message).toContain('the built-in qwen3.6-27b fallback also failed: Request failed with status code 503');
    expect(postedModels()).toEqual(['qwen3-4b', 'qwen3-4b', 'qwen3.6-27b']);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('a colon spec that no longer resolves is a CONFIG error — thrown before any call (the Edge silent-fallback bug class)', async () => {
    mockResolveRegistryModel.mockResolvedValue(null);
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow('no longer resolves to an enabled, [coding]-flagged endpoint model');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a keyless BUILT-IN seat names its env var (the old precise error) before any call', async () => {
    mockResolveRoleModel.mockResolvedValue('');
    delete process.env.DASHSCOPE_API_KEY;
    await expect(runHelperSeatCompletion(CALL)).rejects.toThrow('DASHSCOPE_API_KEY not configured');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('builtIn is honored as the fallback target and stamped on the result', async () => {
    mockPost.mockRejectedValueOnce(http(400)).mockRejectedValueOnce(http(400)).mockResolvedValueOnce(reply('ok'));
    process.env.DEEPSEEK_API_KEY = 'sk-ds';
    const r = await runHelperSeatCompletion({ ...CALL, builtIn: 'deepseek-flash' });
    expect(r.model).toBe('deepseek-flash');
    expect(r.fallback).toMatchObject({ to: 'deepseek-flash' });
    // The DeepSeek built-in is called in its FAST shape (thinking off, no reasoning_effort).
    expect(mockPost.mock.calls[2][1]).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } });
    expect('reasoning_effort' in mockPost.mock.calls[2][1]).toBe(false);
    delete process.env.DEEPSEEK_API_KEY;
  });
});

describe('helperSeatAttributionLine', () => {
  it('reads "<noun> via <builtin> — custom helper seat <label> (<spec>) failed: <reason>"', () => {
    const f = { from: 'cql:qwen3-4b', fromLabel: 'cql (custom endpoint)', to: 'qwen3.6-27b', reason: 'HTTP 400' };
    expect(helperSeatAttributionLine(f)).toBe('digest via qwen3.6-27b — custom helper seat cql (custom endpoint) (cql:qwen3-4b) failed: HTTP 400');
    expect(helperSeatAttributionLine(f, 'worker finished')).toMatch(/^worker finished via qwen3\.6-27b/);
  });
});

describe('workerSeatFailureReason — the streaming worker path decision', () => {
  it('a custom seat 400 (the prod tools=14 shape) → reason with the provider detail', () => {
    expect(workerSeatFailureReason(CUSTOM, { errorStatus: 400, errorMessage: 'Request failed with status code 400', providerError: 'tools not supported' }))
      .toBe('HTTP 400 — tools not supported');
    expect(workerSeatFailureReason(CUSTOM, { errorStatus: 404 })).toBe('HTTP 404');
  });
  it.each([401, 403])('a custom seat %i is a config error → null (the loop\'s own lanes + note surface it)', (status) => {
    expect(workerSeatFailureReason(CUSTOM, { errorStatus: status })).toBeNull();
  });
  it.each([429, 500, 502, 503])('a custom seat %i stays on the TRANSIENT lane (a live server needs time, not a new model) → null', (status) => {
    expect(workerSeatFailureReason(CUSTOM, { errorStatus: status })).toBeNull();
  });
  it('a connection-level failure (server not there) → the code', () => {
    expect(workerSeatFailureReason(CUSTOM, { errorMessage: 'connect ECONNREFUSED 10.0.0.5:8000' })).toBe('ECONNREFUSED');
    expect(workerSeatFailureReason(CUSTOM, { errorMessage: 'getaddrinfo ENOTFOUND llm.cql.ca' })).toBe('ENOTFOUND');
    // ECONNRESET / socket hang up are transient-lane material for a streaming turn.
    expect(workerSeatFailureReason(CUSTOM, { errorMessage: 'read ECONNRESET' })).toBeNull();
  });
  it('a BUILT-IN provider never triggers the seat fallback, whatever the error', () => {
    expect(workerSeatFailureReason(BUILT_IN, { errorStatus: 400 })).toBeNull();
    expect(workerSeatFailureReason(BUILT_IN, { errorMessage: 'connect ECONNREFUSED' })).toBeNull();
  });
});

describe('leadSeatConnectionFailure (lead seat on an unreachable custom endpoint)', () => {
  it('hard codes fall back at once; timeouts/resets only after one prior backoff; HTTP rejections and built-in seats never', () => {
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorMessage: 'connect ECONNREFUSED 10.0.0.5:8000' }, 0)).toBe('ECONNREFUSED');
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorMessage: 'getaddrinfo ENOTFOUND llm.cql.ca' }, 0)).toBe('ENOTFOUND');
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorMessage: 'connect ETIMEDOUT 89.124.37.178:4000' }, 0)).toBeNull();
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorMessage: 'connect ETIMEDOUT 89.124.37.178:4000' }, 1)).toBe('ETIMEDOUT');
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorMessage: 'socket hang up' }, 1)).toBe('socket hang up');
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorStatus: 400, errorMessage: 'tools are not supported' }, 3)).toBeNull();
    expect(leadSeatConnectionFailure('cql:qwen3-4b', { errorStatus: 503, errorMessage: 'ECONNREFUSED upstream' }, 3)).toBeNull();
    expect(leadSeatConnectionFailure('glm-5.3', { errorMessage: 'connect ECONNREFUSED 1.2.3.4:443' }, 0)).toBeNull();
    expect(leadSeatConnectionFailure(undefined, { errorMessage: 'connect ECONNREFUSED 1.2.3.4:443' }, 0)).toBeNull();
  });

  it('a token-idle STALL (runModelTurn stallMs, deep-research councils) is never "unreachable", however many retries burned', () => {
    // integration review 2026-10-20: the stall used to say ETIMEDOUT and moved a custom-endpoint colleague onto
    // the coding_default chain after one retry. The model going quiet is not the host going away.
    for (const n of [0, 1, 2, 5]) {
      expect(leadSeatConnectionFailure('cql-litellm:gw-model', { errorMessage: 'ESTALL: model stream stalled — no tokens for 900s' }, n)).toBeNull();
    }
  });
});

describe('leadSeatHttpFailure (lead seat rejected by the provider)', () => {
  it('classifies 429 / 5xx / billing and nothing else', () => {
    expect(leadSeatHttpFailure({ errorStatus: 429, errorMessage: 'Request failed with status code 429' })).toBe('HTTP 429');
    expect(leadSeatHttpFailure({ errorStatus: 503, errorMessage: 'Service Unavailable' })).toBe('HTTP 503');
    expect(leadSeatHttpFailure({ errorStatus: 429, errorMessage: 'Your account is suspended due to insufficient balance' })).toBe('billing');
    expect(leadSeatHttpFailure({ errorStatus: 402, providerError: 'exceeded_current_quota' })).toBe('billing');
    expect(leadSeatHttpFailure({ errorStatus: 400, errorMessage: 'tools not supported' })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 401, errorMessage: 'bad key' })).toBeNull();
    expect(leadSeatHttpFailure({ errorMessage: 'connect ECONNREFUSED 1.2.3.4:443' })).toBeNull();
    expect(LEAD_BUILTIN_FALLBACK_ORDER).toEqual(['glm-5.3', 'deepseek-flash', 'kimi-k3']);
  });
});

describe('2026-09-29 — a provider quota 403 fails the lead seat over like a 429 (provider-quota.ts)', () => {
  const WEEKLY = "litellm.APIError: APIError: OpenAIException - You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.";
  it('403 weekly limit → HTTP 403; a plain 403 → null', () => {
    expect(leadSeatHttpFailure({ errorStatus: 403, providerError: WEEKLY })).toBe('HTTP 403');
    expect(leadSeatHttpFailure({ errorStatus: 403, providerError: 'Forbidden' })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 429 })).toBe('HTTP 429');
  });
});

// ── Log-signal family lane — tickets 84dbf9c0 + 2eb4e244 (2026-10-27) ──────────
// Characterization pin at the PROD spec (llm-cql:stanne-qwen3-8b-utility, the
// admin's custom Utility endpoint): the two warn rows the hourly log-signal
// sweep filed — 359 rows/24h across the two fingerprints — are DESIGNED
// per-attempt fallback observability, not a defect:
//   helper-seat [web_pipe]: custom helper seat llm-cql (custom endpoint)
//     (llm-cql:stanne-qwen3-8b-utility) failed (timeout) — retrying once on
//     the built-in qwen3.6-27b                          (84dbf9c0, 17 rows)
//   … failed (HTTP 429 — No deployments available for selected model…) — …
//                                                       (2eb4e244, 16 rows)
// ONE warn per failed seat call, at most two hops (custom fallback → built-in,
// never a loop — pinned above), an honest attribution + one seat_fallback row,
// and the caller gets the built-in's answer. The vendor side (LiteLLM
// "No deployments available" 429s / 60s timeouts) is an endpoint-health signal
// the owner acts on in Admin → Endpoints — at pin time the seat probes healthy
// (433 ms, non-streaming completion OK). The sweep's fingerprints normalize
// digits (qwen<n>-<n>b) and truncate — these pins assert the RAW shapes the
// rows carry.
describe('log-signal 84dbf9c0 + 2eb4e244 — the llm-cql utility-seat fallback warn is designed per-attempt observability (prod spec replay)', () => {
  const PROD_SPEC = 'llm-cql:stanne-qwen3-8b-utility';
  const PROD_REG = {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql',
    model: 'stanne-qwen3-8b-utility', label: 'llm-cql', supportsVision: false, coding: true, thinkingOff: false,
  };
  const seatWarns = () => mockWarn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('helper-seat'));

  beforeEach(() => {
    mockResolveRoleModel.mockResolvedValue(PROD_SPEC);
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === PROD_SPEC ? PROD_REG : null));
  });

  it('84dbf9c0 REPLAYS the prod row: a 60s seat timeout logs the exact swept warn once and the built-in answers (a transport error skips the directive retry)', async () => {
    mockPost.mockRejectedValueOnce(coded('ECONNABORTED', 'timeout of 60000ms exceeded')).mockResolvedValueOnce(reply('late digest'));
    const r = await runHelperSeatCompletion({ ...CALL, caller: 'web_pipe' });
    expect(r.text).toBe('late digest');
    expect(r.fallback).toMatchObject({ from: PROD_SPEC, fromLabel: 'llm-cql (custom endpoint)', to: 'qwen3.6-27b', status: 'recovered', reason: 'timeout' });
    expect(postedModels()).toEqual(['stanne-qwen3-8b-utility', 'qwen3.6-27b']); // ONE doomed seat call — no retry ladder
    expect(seatWarns()).toEqual([
      'helper-seat [web_pipe]: custom helper seat llm-cql (custom endpoint) (llm-cql:stanne-qwen3-8b-utility) failed (timeout) — retrying once on the built-in qwen3.6-27b',
    ]);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'recovered', reason: 'timeout', caller: 'web_pipe' }));
  });

  it('2eb4e244 REPLAYS the prod row: a LiteLLM HTTP 429 ("No deployments available…") logs the exact swept warn with the vendor detail, and the built-in answers', async () => {
    const detail = "No deployments available for selected model, Try again in 30 seconds. Passed model=stanne-qwen3-8b-utility. pre-call-checks=True, cooldown_list=['0784c8614b3284', 'qwen3-8b'].";
    mockPost
      .mockRejectedValueOnce(http(429, { error: { message: detail } }))
      .mockRejectedValueOnce(http(429, { error: { message: detail } }))
      .mockResolvedValueOnce(reply('digest'));
    const r = await runHelperSeatCompletion({ ...CALL, caller: 'web_pipe' });
    expect(r.text).toBe('digest');
    expect(r.fallback).toMatchObject({ from: PROD_SPEC, to: 'qwen3.6-27b', status: 'recovered', httpStatus: 429 });
    expect(postedModels()).toEqual(['stanne-qwen3-8b-utility', 'stanne-qwen3-8b-utility', 'qwen3.6-27b']); // directive try + latched retry, then the built-in
    // providerDetail clips the vendor body at 160 chars (+…) inside the 200-char
    // reason cap — the prod row's truncated tail is this clip, by design.
    const clipped = detail.replace(/\s+/g, ' ').trim().slice(0, 160) + '…';
    expect(seatWarns()).toEqual([
      `helper-seat [web_pipe]: custom helper seat llm-cql (custom endpoint) (llm-cql:stanne-qwen3-8b-utility) failed (HTTP 429 — ${clipped}) — retrying once on the built-in qwen3.6-27b`,
    ]);
    expect(r.attribution).toBe(`digest via qwen3.6-27b — custom helper seat llm-cql (custom endpoint) (${PROD_SPEC}) failed: HTTP 429 — ${clipped}`);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ status: 'recovered', httpStatus: 429, caller: 'web_pipe' }));
  });
});
