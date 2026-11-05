/**
 * 2026-09-27 seat/provider limits — the admin role tester sends the seat's REAL
 * request shape (POST /admin/model-roles/test → testModelRole → probeChatCompletion):
 * the seat's tool list trimmed to the model's cap + the effort param the run
 * would send + the custom-endpoint hygiene. A 128-tool cap or a
 * reasoning_effort rejection shows up in the Test button, not in production.
 *
 * Pins: (1) the supervisor seat on an OpenAI-like custom model sends 128 of the
 * 195 registered tools and no reasoning_effort, and says so in the detail;
 * (2) a tools-too-long 400 is explained as TOOL LIMIT with the fix; (3) the exact
 * reasoning_effort 400 is retried once with 'none' and reported as a NOTE with
 * the LiteLLM config line; (4) a 'none' rejection is explained; (5) a built-in
 * seat keeps the full list + its effort param; (6) a process that never
 * registered the assembler probes without tools (the pre-change shape).
 *
 * Mock set mirrors model-roles.service.test.ts.
 */

import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
const mockStoreGet = jest.fn(async () => null);
const mockStorePut = jest.fn(async (..._a: any[]) => {});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...(a as [])),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
const mockResolveRegistryModel = jest.fn();
jest.mock('./model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userPreferences: { findUnique: jest.fn(async () => null) } },
}));
jest.mock('../coding/coding-data.service', () => ({ __esModule: true, resolveOneCodingPick: jest.fn(async () => null) }));
const mockResolveProviderForRun = jest.fn();
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  resolveProviderForRun: (...a: any[]) => mockResolveProviderForRun(...a),
  seatServability: jest.fn(async () => ({ reason: null })),
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));

import axios from 'axios';
import { testModelRole } from './model-roles.service';
import { registerRunToolSchemas, __resetRunToolSchemasForTests } from '../coding/run-tools-registry';
import { __resetReasoningEffortLatchForTests } from '../coding/coding-model';
import { __resetLearnedToolLimitsForTests } from '../coding/provider-limits';

const mockPost = (axios as any).post as jest.Mock;

const SPEC = 'cql-litellm:api-openai-gpt-6-astra';
const REG = {
  url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql-secret',
  model: 'api-openai-gpt-6-astra', label: 'cql-litellm', supportsVision: false, coding: true, chatCapable: true, kind: 'chat',
  matryoshka: false, thinkingOff: false, providerShape: 'openai_chat', providerClass: 'openai', maxTools: 128, maxToolsSource: 'class', reasoningEffort: 'auto',
};
const CUSTOM = { url: REG.url, apiKey: REG.apiKey, model: REG.model, label: 'cql-litellm (custom endpoint)', extra: {}, reasoningEffort: 'auto' as const, maxTools: 128, providerClass: 'openai' as const };
const GLM = { url: 'https://api.z.ai/api/paas/v4/chat/completions', apiKey: 'zai-key', model: 'glm-5.3', label: 'ZAI direct', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } };

const tool = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
const FLEET_TOOLS = [
  ...['read_file', 'run_command', 'search_engine', 'ask_user', 'update_supervisor_state', 'list_chats', 'get_chat_messages', 'send_chat_message', 'schedule_message', 'file_feedback'].map(tool),
  ...Array.from({ length: 185 }, (_, i) => tool(`gmail_send_thing_${i}`)),
];
const TOOLS_TOO_LONG = "litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 64, but got an array with length 128.";
const EFFORT_400 = "litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const http400 = (body: string) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: Readable.from([`{"error":{"message":${JSON.stringify(body)}}}`]) } });
const okStream = () => ({ data: Readable.from(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']) });

beforeEach(() => {
  jest.clearAllMocks();
  __resetRunToolSchemasForTests();
  __resetReasoningEffortLatchForTests();
  __resetLearnedToolLimitsForTests();
  delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX;
  registerRunToolSchemas(() => FLEET_TOOLS);
  mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === SPEC ? REG : null));
  mockResolveProviderForRun.mockImplementation(async (spec: string) => (spec === SPEC ? CUSTOM : spec === 'glm-5.3' ? GLM : { ...GLM, model: spec }));
});

describe('POST /admin/model-roles/test — the REAL request shape', () => {
  it('the supervisor seat on an OpenAI-like custom model sends 128 of the 195 tools (pinned core kept), no reasoning_effort, and says so', async () => {
    mockPost.mockResolvedValueOnce(okStream());
    const r = await testModelRole('supervisor', SPEC);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('128 tool(s) (trimmed from 195');
    expect(r.detail).toContain('reasoning_effort=omitted');
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe(REG.url);
    expect(body.tools).toHaveLength(128);
    const names = body.tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'update_supervisor_state', 'file_feedback']));
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.max_tokens).toBe(16);
    expect(body.stream).toBe(true);
  });

  it('explains a tools-too-long 400 as TOOL LIMIT with the fix (max tools / Detect capabilities), key-scrubbed', async () => {
    mockPost.mockRejectedValueOnce(http400(TOOLS_TOO_LONG));
    const r = await testModelRole('supervisor', SPEC);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('TOOL LIMIT: api-openai-gpt-6-astra accepts at most 64 tools');
    expect(r.error).toContain('"Fleet Supervisor" seat sends 128');
    expect(r.error).toContain('Detect capabilities');
    expect(r.error).not.toContain('sk-cql-secret');
  });

  it("retries the exact reasoning_effort 400 once with 'none' and reports the LiteLLM config line as a NOTE", async () => {
    mockPost.mockRejectedValueOnce(http400(EFFORT_400)).mockResolvedValueOnce(okStream());
    const r = await testModelRole('chat_orchestrator', SPEC);
    expect(r.ok).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][1].reasoning_effort).toBe('none');
    expect(r.detail).toContain("Digby now sends reasoning_effort:'none'");
    expect(r.detail).toContain('reasoning_effort: none under litellm_params');
    // latched for the model: the next probe sends 'none' straight away
    mockPost.mockResolvedValueOnce(okStream());
    const r2 = await testModelRole('chat_orchestrator', SPEC);
    expect(r2.detail).toContain('reasoning_effort=none');
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  it("explains a rejected 'none' retry as REASONING EFFORT with both attempts named", async () => {
    mockPost.mockRejectedValueOnce(http400(EFFORT_400)).mockRejectedValueOnce(http400(EFFORT_400));
    const r = await testModelRole('supervisor', SPEC);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REASONING EFFORT');
    expect(r.error).toContain("reasoning_effort:'none' was rejected too");
    expect(r.error).toContain('/v1/responses');
  });

  it('a built-in seat keeps the full tool list and its effort param', async () => {
    mockPost.mockResolvedValueOnce(okStream());
    const r = await testModelRole('supervisor', 'glm-5.3');
    expect(r.ok).toBe(true);
    const body = mockPost.mock.calls[0][1];
    expect(body.tools).toHaveLength(195);
    expect(body.reasoning_effort).toBe('max');
    expect(r.detail).toContain('195 tool(s), reasoning_effort=max');
  });

  it('without a registered assembler the probe sends no tools (the pre-change shape) and still passes', async () => {
    __resetRunToolSchemasForTests();
    mockPost.mockResolvedValueOnce(okStream());
    const r = await testModelRole('supervisor', SPEC);
    expect(r.ok).toBe(true);
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('tools');
    expect(r.detail).toContain('0 tool(s)');
  });
});
