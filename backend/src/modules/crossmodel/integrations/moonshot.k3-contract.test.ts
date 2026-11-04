/**
 * Kimi K3 request-contract tests (audit p4, 2026-08-13).
 *
 * PR #193 swapped KIMI_MODEL to 'kimi-k3' but kept the K2.6 parameter contract
 * (temperature/top_p/max_tokens), which K3 rejects with a 400 — the live
 * profile-interview path (/api/crossmodel/profile/stream) died in prod. These
 * tests pin the K3 contract the repo documents in coding/coding-model.ts on
 * every payload this integration sends: NO temperature, NO top_p, NO
 * max_tokens; output cap via max_completion_tokens; profile paths stream,
 * skip reasoning_content deltas, and survive a dead stream via the idle
 * watchdog instead of hanging.
 */
import { Readable } from 'stream';

// The profile interview runs on the Digby SEAT since 2026-09-22 (model role
// chat_orchestrator, resolved through coding-model → model-roles.service by
// dynamic import; the real module pulls config/env). Mocked: no override →
// the built-in kimi-k3 contract this file pins.
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
  getModelRoleOverrides: async () => ({}),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../utils/utility-llm', () => ({
  utilityChat: jest.fn().mockResolvedValue(''),
  UTILITY_MODEL_NAME: 'deepseek-flash',
  sanitizeStatusLine: (s: string) => s,
}));

// Heavy module-graph boundaries — mocked so the import graph never reaches
// config/env at import time (same set as moonshot.integration.test.ts).
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn().mockResolvedValue(''),
  SEARCH_UNAVAILABLE_NOTE: '',
}));
jest.mock('../tool-executor', () => ({
  ToolCache: jest.fn(),
  TOOL_DEFINITIONS: [],
  processToolCalls: jest.fn(),
}));

jest.mock('axios');

import axios from 'axios';

// The module captures MOONSHOT_API_KEY at load time — set it BEFORE loading
// (require is not hoisted above this assignment, unlike an import statement).
process.env.MOONSHOT_API_KEY = 'test-key';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const moonshotIntegration = require('./moonshot.integration').default;

const mockedPost = axios.post as jest.Mock;

/** Build a fake Moonshot SSE stream from raw event lines. */
function sseStream(lines: string[]): Readable {
  return Readable.from([Buffer.from(lines.map(l => `data: ${l}\n`).join(''))]);
}

/** A reasoning delta followed by content deltas, then [DONE]. */
function k3ReplyStream(contentParts: string[]): Readable {
  return sseStream([
    JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking about the reply...' } }] }),
    ...contentParts.map(c => JSON.stringify({ choices: [{ delta: { content: c } }] })),
    '[DONE]',
  ]);
}

/** Assert a request body follows the K3 contract from coding/coding-model.ts. */
function expectK3Contract(body: any) {
  expect(body.model).toBe('kimi-k3');
  expect(body.max_completion_tokens).toEqual(expect.any(Number));
  expect(body).not.toHaveProperty('temperature');
  expect(body).not.toHaveProperty('top_p');
  expect(body).not.toHaveProperty('max_tokens');
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

beforeEach(() => {
  mockedPost.mockReset();
});

describe('profileStream — K3 contract (the live onboarding path)', () => {
  it('sends a contract-clean streaming payload and skips reasoning deltas', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['Hi', ' there!']) });

    const out = await collect(moonshotIntegration.profileStream('hello', []));

    expect(out).toBe('Hi there!'); // reasoning_content never surfaces
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [, body, config] = mockedPost.mock.calls[0];
    expectK3Contract(body);
    expect(body.stream).toBe(true);
    expect(config.responseType).toBe('stream');
    // The K2.6 "instant mode" 30s deadline is gone — K3 reasons before content.
    expect(config.timeout).toBeGreaterThan(30000);
  });

  it('yields the connection fallback when the request fails (e.g. payload 400)', async () => {
    mockedPost.mockRejectedValueOnce(new Error('Request failed with status code 400'));

    const out = await collect(moonshotIntegration.profileStream('hello', []));

    expect(out).toContain("I'm having trouble connecting right now");
  });

  it('idle watchdog: a silent stream falls back instead of hanging forever', async () => {
    jest.useFakeTimers();
    try {
      const stalled = new Readable({ read() { /* never pushes */ } });
      mockedPost.mockResolvedValueOnce({ data: stalled });

      const consumed = collect(moonshotIntegration.profileStream('hello', []));
      await jest.advanceTimersByTimeAsync(31000); // > IDLE_TIMEOUT_MS

      const out = await consumed;
      expect(out).toContain("I'm having trouble connecting right now");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('profileStreamContinuation — K3 contract', () => {
  it('sends a contract-clean streaming payload', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['Welcome back!']) });

    const out = await collect(
      moonshotIntegration.profileStreamContinuation('hi again', { name: 'Paul' }, [])
    );

    expect(out).toBe('Welcome back!');
    const [, body, config] = mockedPost.mock.calls[0];
    expectK3Contract(body);
    expect(body.stream).toBe(true);
    expect(config.timeout).toBeGreaterThan(30000);
  });
});

describe('query — K3 contract on the streaming path', () => {
  it('sends no sampling params and caps output via max_completion_tokens', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['The answer.']) });

    const result = await moonshotIntegration.query('what is up?', 'thinking', false, []);

    expect(result.response).toBe('The answer.');
    expect(result.modelUsed).toBe('kimi-k3');
    const [, body] = mockedPost.mock.calls[0];
    expectK3Contract(body);
    expect(body.stream).toBe(true);
  });
});

describe('agentic loop — K3 contract on the tool-calling path', () => {
  it('sends no sampling params alongside tools', async () => {
    // Fake timers keep the loop's 120s race timer from holding the process.
    jest.useFakeTimers();
    try {
      mockedPost.mockResolvedValueOnce({
        data: { choices: [{ message: { content: 'Tool-grounded answer with no tool calls.' } }] },
      });

      const result = await moonshotIntegration.query(
        'search something', 'thinking', true, [], undefined, undefined, {} as any
      );

      expect(result.response).toBe('Tool-grounded answer with no tool calls.');
      expect(mockedPost).toHaveBeenCalledTimes(1);
      const [, body] = mockedPost.mock.calls[0];
      expectK3Contract(body);
      expect(body).toHaveProperty('tools');
      expect(body).not.toHaveProperty('stream'); // tool-call path is non-streaming by design
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('synthesizeStream — K3 contract', () => {
  it('sends a contract-clean streaming payload and yields only content', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['Unified', ' answer.']) });

    const out = await collect(moonshotIntegration.synthesizeStream(
      'original question',
      { glm: { response: 'draft', time: 100 } as any },
      []
    ));

    expect(out).toBe('Unified answer.');
    const [, body] = mockedPost.mock.calls[0];
    expectK3Contract(body);
    expect(body.stream).toBe(true);
  });
});

describe('profile-interview branding (ticket 42e46468)', () => {
  it('PROFILER_PROMPT brands the product Digby, drops CrossModel, names newer capabilities', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['Hi!']) });

    await collect(moonshotIntegration.profileStream('hello', []));

    const [, body] = mockedPost.mock.calls[0];
    const system = body.messages.find((m: any) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system.content).toContain('Digby');
    expect(system.content).not.toContain('CrossModel');
    // newer-framework capabilities surfaced to the interviewee
    expect(system.content).toMatch(/council|cross-check|multi-model/i);
    expect(system.content).toMatch(/remembers|memory|across sessions/i);
    expect(system.content).toMatch(/schedule|digest|coding session|Slack|Google|GitHub|web search/i);
  });

  it('CONTINUATION_PROMPT brands the product Digby and drops CrossModel', async () => {
    mockedPost.mockResolvedValueOnce({ data: k3ReplyStream(['Welcome back!']) });

    await collect(moonshotIntegration.profileStreamContinuation('hi', { name: 'Paul' }, []));

    const [, body] = mockedPost.mock.calls[0];
    const system = body.messages.find((m: any) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system.content).toContain('Digby');
    expect(system.content).not.toContain('CrossModel');
  });
});
