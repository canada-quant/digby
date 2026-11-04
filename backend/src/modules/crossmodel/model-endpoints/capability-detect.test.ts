/**
 * capability-detect — the automatic capability-detection suite for custom-endpoint
 * models (2026-09-27). Every probe verdict path is replayed against a FAKE
 * OpenAI-compatible server (axios mocked, routed by request shape), the pure
 * flag application is unit-tested (manualFlags respected, `changed` list, kind
 * derivation), the ≤4-models concurrency is measured with an in-flight counter,
 * the kill switch / 404 / 400 paths are pinned, and no evidence string ever
 * carries the API key — even when the provider echoes it back in a 400 body.
 *
 * Mock set mirrors model-endpoints.service.test.ts (in-memory prisma, real
 * credentials.service under a test JWT_SECRET, real model-endpoints.service) plus
 * the verifier test's boundary stubs for model-roles.service (probeEmbeddings /
 * probeRerank stubbed, scrubError / authHeaders REAL) and the dynamic-import
 * modules (decision-gate, image-generate).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

const db: any[] = [];
let nextId = 1;
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    modelEndpoint: {
      findMany: jest.fn(async () => [...db]),
      findUnique: jest.fn(async ({ where }: any) => db.find(r => r.id === where.id) || null),
      findFirst: jest.fn(async ({ where }: any) => db.find(r => (where.label === undefined || r.label === where.label) && (where.enabled === undefined || r.enabled === where.enabled) && (where.id?.not === undefined || r.id !== where.id.not)) || null),
      create: jest.fn(async ({ data }: any) => { const row = { id: `e${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...data }; db.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => { const i = db.findIndex(r => r.id === where.id); if (i < 0) throw new Error('not found'); db[i] = { ...db[i], ...data }; return db[i]; }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  },
}));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));

const mockProbeEmbeddings = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: false, target: 't', latencyMs: 1, error: 'HTTP 404 Not Found' }));
const mockProbeRerank = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: false, target: 't', latencyMs: 1, error: 'HTTP 404 Not Found' }));
jest.mock('./model-roles.service', () => ({
  __esModule: true,
  ...jest.requireActual('./model-roles.service'),
  probeEmbeddings: (...a: any[]) => mockProbeEmbeddings(...a),
  probeRerank: (...a: any[]) => mockProbeRerank(...a),
}));

const mockProbeSystemOne = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: false, target: 't', latencyMs: 2, error: 'not a typed-decision model' }));
jest.mock('../platform/decision-gate', () => ({ __esModule: true, probeSystemOneServer: (...a: any[]) => mockProbeSystemOne(...a) }));

const mockProbeImage = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: true, latencyMs: 3, detail: '64×64 png in 3 ms' }));
// 61d33af9: the module surface gained imageProbeTimeoutMs (the 180 s env-clamped
// budget) — the mock must mirror it or runProbe's guard computes NaN.
jest.mock('../image-generate', () => ({ __esModule: true, probeImageGenerate: (...a: any[]) => mockProbeImage(...a), IMAGE_PROBE_TIMEOUT_MS: 180_000, imageProbeTimeoutMs: () => 180_000 }));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { Readable } from 'stream';
import { createEndpoint, resolveRegistryModel, clearRegistryModelCache } from './model-endpoints.service';
import type { DetectedCapabilityResult, EndpointModelEntry } from './model-endpoints.service';
import {
  detectEndpointCapabilities, applyDetectionToEntry, selectCapabilities, looksLikeImageModel, parseEmbeddingDims,
  THINKING_DIRECTIVE_HONOURED, MATRYOSHKA_TRUNCATED_MARK, DETECT_MAX_CONCURRENT_MODELS,
} from './capability-detect';

const KEY = 'sk-cql-secret-key-0042';
const BASE = 'https://llm.example.com/v1';
const ASTRA = 'api-openai-gpt-6-astra';
const EFFORT_400 = "litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const TOOLS_400 = "litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 200.";

const httpErr = (status: number, message: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { message } } } });
const sseJson = (frames: any[], done = true) => Readable.from([...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), ...(done ? ['data: [DONE]\n\n'] : [])]);
const jsonFrame = (delta: any, finish: string | null = null) => ({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] });

/** The fake server's behaviour, per test. */
interface Fake {
  stream?: 'json' | 'raw' | 'empty' | 'error';
  reasoning?: boolean;           // the stream / plain answers carry reasoning_content
  toolCalls?: 'yes' | 'no' | 'effort400' | 'other400' | 500;
  maxTools?: 'ok' | 'cap128' | 'noNumber' | 'below128' | 'effort400';
  effort?: 'ok' | 'unsupported' | 'other400';
  thinkingOff?: 'honoured' | 'ignored' | 'rejected';
  vision?: boolean;
  modelsMeta?: Record<string, any> | null;
  onPost?: () => Promise<void> | void;
}
let fake: Fake = {};
const seenPosts: any[] = [];

function installFake(f: Fake) {
  fake = f;
  seenPosts.length = 0;
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
  mockedAxios.post.mockImplementation(async (_url: string, body: any) => {
    seenPosts.push(body);
    await fake.onPost?.();
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    const content = body.messages?.[0]?.content;
    const reasoning = fake.reasoning ? { reasoning_content: 'let me think…' } : {};
    if (body.stream === true) {
      if (fake.stream === 'raw') return { data: Readable.from(['data: OK\n', 'data:  there\n']) } as any;
      if (fake.stream === 'empty') return { data: Readable.from([]) } as any;
      if (fake.stream === 'error') throw httpErr(500, 'upstream exploded');
      return { data: sseJson([jsonFrame({ role: 'assistant', ...reasoning }), jsonFrame({ content: 'OK' }, 'stop')]) } as any;
    }
    if (Array.isArray(content) && content.some((p: any) => p?.type === 'image_url')) {
      if (fake.vision === false) throw httpErr(400, 'Invalid content: image input is not supported for this model');
      return { data: { choices: [{ message: { role: 'assistant', content: 'transparent' } }] } };
    }
    if (body.chat_template_kwargs) {
      if (fake.thinkingOff === 'rejected') throw httpErr(400, 'Unsupported parameter: chat_template_kwargs');
      if (fake.thinkingOff === 'ignored') return { data: { choices: [{ message: { role: 'assistant', content: 'OK', reasoning_content: 'still thinking' } }] } };
      return { data: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } };
    }
    if (tools >= 100) {
      if (fake.maxTools === 'effort400') throw httpErr(400, EFFORT_400);
      if (fake.maxTools === 'cap128') throw httpErr(400, TOOLS_400);
      if (fake.maxTools === 'noNumber') { if (tools === 200) throw httpErr(400, 'too many tools in the request'); return { data: { choices: [{ message: { content: 'OK' } }] } }; }
      if (fake.maxTools === 'below128') throw httpErr(400, 'too many tools in the request');
      return { data: { choices: [{ message: { content: 'OK' } }] } };
    }
    if (tools === 1 && body.reasoning_effort) {
      if (fake.effort === 'unsupported') throw httpErr(400, EFFORT_400);
      if (fake.effort === 'other400') throw httpErr(400, 'Unsupported parameter: tool_choice');
      return { data: { choices: [{ message: { content: 'OK' } }] } };
    }
    if (tools === 1) {
      if (fake.toolCalls === 'effort400') throw httpErr(400, `${EFFORT_400} (Bearer ${KEY} echoed)`);
      if (fake.toolCalls === 'other400') throw httpErr(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser');
      if (fake.toolCalls === 500) throw httpErr(500, 'upstream exploded');
      if (fake.toolCalls === 'no') return { data: { choices: [{ message: { role: 'assistant', content: 'pong (no tool call)' } }] } };
      return { data: { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] } };
    }
    return { data: { choices: [{ message: { role: 'assistant', content: 'OK', ...reasoning } }] } };
  });
  mockedAxios.get.mockImplementation(async () => {
    if (fake.modelsMeta === null) throw httpErr(404, 'no such route');
    return { data: { data: [{ id: ASTRA, ...(fake.modelsMeta ?? {}) }, { id: 'other' }] } } as any;
  });
}

async function seed(models: EndpointModelEntry[] = [{ id: ASTRA }]) {
  const ep = await createEndpoint({ label: 'cql-litellm', providerShape: 'openai_chat', baseUrl: BASE, apiKey: KEY, models });
  clearRegistryModelCache();
  return ep;
}
const rowOf = (results: DetectedCapabilityResult[], cap: string) => results.find((r) => r.capability === cap)!;

beforeEach(() => {
  db.length = 0;
  nextId = 1;
  clearRegistryModelCache();
  jest.clearAllMocks();
  installFake({});
});

describe('detectEndpointCapabilities — guards', () => {
  it('unknown endpoint → 404; unknown model → 400', async () => {
    const ep = await seed();
    await expect(detectEndpointCapabilities('nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(detectEndpointCapabilities(ep.id, { modelId: 'ghost' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not registered') });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('selectCapabilities: unknown names dropped, empty = the whole suite, duplicates collapsed', () => {
    // 12 since 2026-09-28: the decision probe joined the suite (a decision model's only probe).
    expect(selectCapabilities(undefined)).toHaveLength(12);
    expect(selectCapabilities(['vision', 'bogus', 'vision'])).toEqual(['vision']);
    expect(selectCapabilities([])).toHaveLength(12);
  });
});

describe('probe 1 — chat_stream', () => {
  it('OpenAI JSON chunks → json; reasoning_content noted', async () => {
    installFake({ stream: 'json', reasoning: true });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream'] });
    const row = rowOf(r.models[0].results, 'chat_stream');
    expect(row).toMatchObject({ ok: true, value: 'json' });
    expect(row.evidence).toContain('2 OpenAI JSON chunk(s)');
    expect(row.evidence).toContain('thinks by default');
    expect(r.models[0].entry.kind).toBe('chat');
    expect(r.models[0].entry.capabilities?.results).toHaveLength(1);
  });
  it('raw-text data: lines → raw_text (tool calls cannot ride it)', async () => {
    installFake({ stream: 'raw' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream'] });
    expect(rowOf(r.models[0].results, 'chat_stream')).toMatchObject({ ok: true, value: 'raw_text' });
    expect(rowOf(r.models[0].results, 'chat_stream').evidence).toContain('RAW-TEXT');
  });
  it('an empty stream or a 500 → ok:false, value null', async () => {
    installFake({ stream: 'empty' });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream'] });
    expect(rowOf(r.models[0].results, 'chat_stream')).toMatchObject({ ok: false, value: null });
    installFake({ stream: 'error' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream'] });
    expect(rowOf(r.models[0].results, 'chat_stream')).toMatchObject({ ok: false, value: null });
    expect(rowOf(r.models[0].results, 'chat_stream').evidence).toContain('HTTP 500');
  });
});

describe('probe 2 — tool_calling', () => {
  it('tool_calls returned → true; prose → false; the effort 400 → null + feeds reasoning_effort', async () => {
    installFake({ toolCalls: 'yes' });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['tool_calling'] });
    expect(rowOf(r.models[0].results, 'tool_calling')).toMatchObject({ ok: true, value: true });
    expect(rowOf(r.models[0].results, 'tool_calling').evidence).toContain('ping');
    expect(r.models[0].entry.kind).toBe('chat');

    installFake({ toolCalls: 'no' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['tool_calling'] });
    expect(rowOf(r.models[0].results, 'tool_calling')).toMatchObject({ ok: true, value: false });

    installFake({ toolCalls: 'effort400' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['tool_calling', 'reasoning_effort'] });
    expect(rowOf(r.models[0].results, 'tool_calling')).toMatchObject({ ok: true, value: null });
    expect(rowOf(r.models[0].results, 'tool_calling').evidence).toContain('reasoning_effort');
    // probe 4 took the verdict from probe 2 without a second request naming reasoning_effort
    const eff = rowOf(r.models[0].results, 'reasoning_effort');
    expect(eff).toMatchObject({ ok: true, value: 'unsupported' });
    expect(eff.evidence).toContain("set reasoning_effort to 'none'");
    expect(seenPosts.filter((b) => b.reasoning_effort)).toHaveLength(0);
    expect(r.models[0].entry.reasoningEffort).toBe('unsupported');

    installFake({ toolCalls: 'other400' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['tool_calling'] });
    expect(rowOf(r.models[0].results, 'tool_calling')).toMatchObject({ ok: true, value: null });

    installFake({ toolCalls: 500 });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['tool_calling'] });
    expect(rowOf(r.models[0].results, 'tool_calling')).toMatchObject({ ok: false, value: null });
  });
});

describe('probe 3 — max_tools', () => {
  it('200 accepted → 200 (no cap seen)', async () => {
    installFake({ maxTools: 'ok' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['max_tools'] });
    expect(rowOf(r.models[0].results, 'max_tools')).toMatchObject({ ok: true, value: 200 });
    expect(r.models[0].entry.maxTools).toBeUndefined();
    expect(seenPosts).toHaveLength(1);
  });
  it('the incident body → cap 128 read from the 400, one request', async () => {
    installFake({ maxTools: 'cap128' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['max_tools'] });
    expect(rowOf(r.models[0].results, 'max_tools')).toMatchObject({ ok: true, value: 128 });
    expect(r.models[0].entry.maxTools).toBe(128);
    expect(r.models[0].changed).toContain('maxTools=128');
    expect(seenPosts).toHaveLength(1);
    expect((await resolveRegistryModel(`cql-litellm:${ASTRA}`))?.maxTools).toBe(128); // persisted
  });
  it('"too many tools" without a number → 128 retried once: OK ⇒ 128; still 400 ⇒ null (set by hand)', async () => {
    installFake({ maxTools: 'noNumber' });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['max_tools'] });
    expect(rowOf(r.models[0].results, 'max_tools')).toMatchObject({ ok: true, value: 128 });
    expect(seenPosts.map((b) => b.tools.length)).toEqual([200, 128]);
    installFake({ maxTools: 'below128' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['max_tools'] });
    expect(rowOf(r.models[0].results, 'max_tools')).toMatchObject({ ok: true, value: null });
    expect(rowOf(r.models[0].results, 'max_tools').evidence).toContain('below 128');
    expect(seenPosts).toHaveLength(2); // bounded to 2 requests
  });
  it('a 400 that is not about the array length is reported, not mistaken for a cap', async () => {
    installFake({ maxTools: 'effort400' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['max_tools'] });
    expect(rowOf(r.models[0].results, 'max_tools')).toMatchObject({ ok: true, value: null });
    expect(rowOf(r.models[0].results, 'max_tools').evidence).toContain('reasoning_effort_unsupported');
  });
});

describe('probe 4 — reasoning_effort', () => {
  it("'low' accepted → supported; the exact LiteLLM body → unsupported with the /v1/responses-or-none note; other 400 → null", async () => {
    installFake({ effort: 'ok' });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['reasoning_effort'] });
    expect(rowOf(r.models[0].results, 'reasoning_effort')).toMatchObject({ ok: true, value: 'supported' });
    expect(seenPosts[0]).toMatchObject({ reasoning_effort: 'low' });
    expect(r.models[0].entry.reasoningEffort).toBe('supported');

    installFake({ effort: 'unsupported' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['reasoning_effort'] });
    const row = rowOf(r.models[0].results, 'reasoning_effort');
    expect(row).toMatchObject({ ok: true, value: 'unsupported' });
    expect(row.evidence).toContain('use /v1/responses or set reasoning_effort to');
    expect(row.evidence).toContain('litellm_params');
    expect(r.models[0].entry.reasoningEffort).toBe('unsupported');
    expect(r.models[0].changed).toContain('reasoningEffort=unsupported');

    installFake({ effort: 'other400' });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['reasoning_effort'] });
    expect(rowOf(r.models[0].results, 'reasoning_effort')).toMatchObject({ ok: true, value: null });
  });
});

describe('probe 5 — thinking_default', () => {
  it('no reasoning in the stream → false, directive not tried', async () => {
    installFake({ stream: 'json', reasoning: false });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream', 'thinking_default'] });
    expect(rowOf(r.models[0].results, 'thinking_default')).toMatchObject({ ok: true, value: false });
    expect(seenPosts.filter((b) => b.chat_template_kwargs)).toHaveLength(0);
    expect(r.models[0].entry.thinking).toBeUndefined();
  });
  it('reasoning seen + directive honoured → thinking:off set; ignored → not set; rejected → latch note, not set', async () => {
    installFake({ stream: 'json', reasoning: true, thinkingOff: 'honoured' });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream', 'thinking_default'] });
    let row = rowOf(r.models[0].results, 'thinking_default');
    expect(row).toMatchObject({ ok: true, value: true });
    expect(row.evidence.startsWith(THINKING_DIRECTIVE_HONOURED)).toBe(true);
    expect(seenPosts.filter((b) => b.chat_template_kwargs?.enable_thinking === false)).toHaveLength(1);
    expect(r.models[0].entry.thinking).toBe('off');
    expect(r.models[0].changed).toContain('thinking=off');

    installFake({ stream: 'json', reasoning: true, thinkingOff: 'ignored' });
    const ep2 = await createEndpoint({ label: 'two', providerShape: 'openai_chat', baseUrl: BASE, apiKey: KEY, models: [{ id: ASTRA }] });
    r = await detectEndpointCapabilities(ep2.id, { capabilities: ['chat_stream', 'thinking_default'] });
    row = rowOf(r.models[0].results, 'thinking_default');
    expect(row).toMatchObject({ ok: true, value: true });
    expect(row.evidence).toContain('directive IGNORED');
    expect(r.models[0].entry.thinking).toBeUndefined();

    installFake({ stream: 'json', reasoning: true, thinkingOff: 'rejected' });
    const ep3 = await createEndpoint({ label: 'three', providerShape: 'openai_chat', baseUrl: BASE, apiKey: KEY, models: [{ id: ASTRA }] });
    r = await detectEndpointCapabilities(ep3.id, { capabilities: ['chat_stream', 'thinking_default'] });
    row = rowOf(r.models[0].results, 'thinking_default');
    expect(row).toMatchObject({ ok: true, value: true });
    expect(row.evidence).toContain('directive REJECTED');
    expect(row.evidence).toContain('latch');
    expect(r.models[0].entry.thinking).toBeUndefined();
  });
  it('without the stream probe in the run, one plain call decides whether the model thinks', async () => {
    installFake({ reasoning: true, thinkingOff: 'honoured' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['thinking_default'] });
    expect(rowOf(r.models[0].results, 'thinking_default')).toMatchObject({ ok: true, value: true });
    expect(seenPosts).toHaveLength(2); // the plain call + the directive call
    expect(r.models[0].entry.thinking).toBe('off');
  });
});

describe('probe 6 — vision', () => {
  it('image part accepted → vision true; 400 → false (and a stale flag is cleared)', async () => {
    installFake({ vision: true });
    const ep = await seed([{ id: ASTRA }]);
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['vision'] });
    expect(rowOf(r.models[0].results, 'vision')).toMatchObject({ ok: true, value: true });
    expect(r.models[0].entry.vision).toBe(true);
    expect(r.models[0].changed).toContain('vision=true');
    installFake({ vision: false });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['vision'] });
    expect(rowOf(r.models[0].results, 'vision')).toMatchObject({ ok: true, value: false });
    expect(r.models[0].entry.vision).toBeUndefined();
    expect(r.models[0].changed).toContain('vision=unset');
    const sent = seenPosts[0].messages[0].content;
    expect(sent.find((p: any) => p.type === 'image_url').image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('probes 7–9 — embeddings / rerank / typed decisions', () => {
  it('embeddings: 1536 native → dims; an MRL model truncated OK → matryoshka set; a >1536 refusal keeps the fix text; 404 → no route', async () => {
    const ep = await seed([{ id: 'Qwen/Qwen3-Embedding-8B', matryoshka: true }, { id: 'bge-m3' }, { id: 'nomic-embed-text' }]);
    mockProbeEmbeddings.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 1, detail: 'embedding OK — native 4096 dims, Matryoshka-truncated to 1536 client-side (the server ignored the `dimensions` request)' });
    let r = await detectEndpointCapabilities(ep.id, { modelId: 'Qwen/Qwen3-Embedding-8B', capabilities: ['embeddings'] });
    let row = rowOf(r.models[0].results, 'embeddings');
    expect(row).toMatchObject({ ok: true, value: 4096 });
    expect(row.evidence).toContain(MATRYOSHKA_TRUNCATED_MARK);
    expect(r.models[0].entry).toMatchObject({ matryoshka: true, kind: 'embeddings' });
    expect(mockProbeEmbeddings).toHaveBeenCalledWith('cql-litellm:Qwen/Qwen3-Embedding-8B');

    mockProbeEmbeddings.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 1, detail: 'embedding OK — 1536 dimensions' });
    r = await detectEndpointCapabilities(ep.id, { modelId: 'bge-m3', capabilities: ['embeddings'] });
    expect(rowOf(r.models[0].results, 'embeddings')).toMatchObject({ ok: true, value: 1536 });
    expect(r.models[0].entry.matryoshka).toBeUndefined();

    mockProbeEmbeddings.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 1, error: 'The server IGNORED the `dimensions` request and returned 768-dimensional vectors. Digby\'s vector store is pinned to 1536 and a shorter vector cannot be padded — pick a model that outputs 1536 dims.' });
    r = await detectEndpointCapabilities(ep.id, { modelId: 'nomic-embed-text', capabilities: ['embeddings'] });
    row = rowOf(r.models[0].results, 'embeddings');
    expect(row).toMatchObject({ ok: false, value: 768 });
    expect(row.evidence).toContain('pinned to 1536');

    mockProbeEmbeddings.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 1, error: 'HTTP 404 Not Found' });
    r = await detectEndpointCapabilities(ep.id, { modelId: 'bge-m3', capabilities: ['embeddings'] });
    row = rowOf(r.models[0].results, 'embeddings');
    expect(row).toMatchObject({ ok: false, value: null });
    expect(row.evidence).toContain('no /embeddings route');
  });
  it('rerank + typed decisions set their kinds / flags', async () => {
    const ep = await seed([{ id: 'bge-reranker-v2-m3' }, { id: 'agx-laya' }]);
    mockProbeRerank.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 1, detail: 'rerank OK — 1 scored result(s)' });
    let r = await detectEndpointCapabilities(ep.id, { modelId: 'bge-reranker-v2-m3', capabilities: ['rerank'] });
    expect(rowOf(r.models[0].results, 'rerank')).toMatchObject({ ok: true, value: true });
    expect(r.models[0].entry.kind).toBe('rerank');

    mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 2, detail: 'typed decision OK (refund=yes, team=billing)' });
    r = await detectEndpointCapabilities(ep.id, { modelId: 'agx-laya', capabilities: ['typed_decisions'] });
    expect(rowOf(r.models[0].results, 'typed_decisions')).toMatchObject({ ok: true, value: true });
    expect(mockProbeSystemOne).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: BASE, apiKey: KEY, model: 'agx-laya', transport: 'chat' }));
    expect(r.models[0].entry).toMatchObject({ decision: 'systemone_chat', kind: 'decision' });
    expect(r.models[0].changed).toEqual(expect.arrayContaining(['decision=systemone_chat', 'kind=decision']));

    mockProbeRerank.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 1, error: 'HTTP 404' });
    r = await detectEndpointCapabilities(ep.id, { modelId: 'bge-reranker-v2-m3', capabilities: ['rerank'] });
    expect(rowOf(r.models[0].results, 'rerank')).toMatchObject({ ok: true, value: false });
  });
});

describe('probe 10 — image_generation (spend-gated)', () => {
  it('skipped for a chat-looking id; probed for an image id and sets [image]', async () => {
    const ep = await seed([{ id: ASTRA }, { id: 'z-image-turbo' }]);
    let r = await detectEndpointCapabilities(ep.id, { modelId: ASTRA, capabilities: ['image_generation'] });
    expect(rowOf(r.models[0].results, 'image_generation')).toMatchObject({ ok: true, value: null, skipped: true });
    expect(mockProbeImage).not.toHaveBeenCalled();
    r = await detectEndpointCapabilities(ep.id, { modelId: 'z-image-turbo', capabilities: ['image_generation'] });
    expect(rowOf(r.models[0].results, 'image_generation')).toMatchObject({ ok: true, value: true });
    expect(mockProbeImage).toHaveBeenCalledWith('cql-litellm:z-image-turbo', 180_000); // 61d33af9: the image probe budget follows imageProbeTimeoutMs (55 s → 180 s)
    expect(r.models[0].entry).toMatchObject({ image: true, kind: 'image' });
    expect(looksLikeImageModel({ id: 'anything', image: true })).toBe(true);
    expect(looksLikeImageModel({ id: 'gpt-6-astra' })).toBe(false);
  });
  it('bd51693b: a per-entry imageTimeoutMs raises the inner probe budget AND the outer guard with it — the Detect dialog never cuts a raised probe at the stock 185 s', async () => {
    // The ticket's own scenario: the admin unblocked a 5-min backend with a
    // 600 s entry timeout; the INNER probe already budgets for it (04c8ffd1
    // review B1) but the OUTER guard was still the flat 185 s, so Detect
    // reported "failed" against its own raised budget. Mirrors the
    // model-roles Test-button B1 tests (role-test-stream.61d33af9.test.ts).
    const ep = await seed([{ id: 'qwen-image-2.1', image: true, imageTimeoutMs: 600_000 }]);
    mockProbeImage.mockImplementation(async (_spec: string, budgetMs: number) => {
      expect(budgetMs).toBe(600_000); // inner budget raised with the entry — never the stock 180 s
      return { ok: true, latencyMs: 595_000, detail: 'qwen-image-2.1 OK — 512×512 image/png (custom, 595.0s)' };
    });
    const r = await detectEndpointCapabilities(ep.id, { modelId: 'qwen-image-2.1', capabilities: ['image_generation'] });
    expect(rowOf(r.models[0].results, 'image_generation')).toMatchObject({ ok: true, value: true });
    expect(mockProbeImage).toHaveBeenCalledWith('cql-litellm:qwen-image-2.1', 600_000);
  });
  it('bd51693b: the outer guard FOLLOWS the raised entry budget — a never-settling 240 s entry probe is not cut at the stock 185 s wall', async () => {
    jest.useFakeTimers();
    try {
      mockProbeImage.mockReturnValue(new Promise(() => { /* never settles */ }) as any);
      const ep = await seed([{ id: 'qwen-image-2.1', image: true, imageTimeoutMs: 240_000 }]);
      const pending = detectEndpointCapabilities(ep.id, { modelId: 'qwen-image-2.1', capabilities: ['image_generation'] });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      // The stock wall (180 s budget + 5 s grace = 185 s) must NOT fire first:
      // the outer guard is max(180 s, 240 s entry) + grace.
      await jest.advanceTimersByTimeAsync(185_000 + 10);
      expect(await Promise.race([pending.then(() => 'settled'), Promise.resolve('still-running')])).toBe('still-running');
      await jest.advanceTimersByTimeAsync(240_000 - 180_000 + 5_000);
      const r = await pending;
      expect(rowOf(r.models[0].results, 'image_generation')).toMatchObject({ ok: false, value: null });
      expect(rowOf(r.models[0].results, 'image_generation').evidence).toContain('did not complete within 245');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('probe 11 — context_window', () => {
  it('reads the first known field from /models; blank when absent; ok:false on a failed GET', async () => {
    installFake({ modelsMeta: { max_model_len: 131072 } });
    const ep = await seed();
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    expect(rowOf(r.models[0].results, 'context_window')).toMatchObject({ ok: true, value: 131072 });
    expect(rowOf(r.models[0].results, 'context_window').evidence).toContain('max_model_len=131072');
    expect(r.models[0].entry.contextWindow).toBe(131072);
    expect(r.models[0].changed).toContain('contextWindow=131072');
    expect(mockedAxios.get).toHaveBeenCalledWith(`${BASE}/models`, expect.objectContaining({ timeout: 5_000 }));

    installFake({ modelsMeta: {} });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    expect(rowOf(r.models[0].results, 'context_window')).toMatchObject({ ok: true, value: null });
    expect(r.models[0].entry.contextWindow).toBe(131072); // left as it was

    installFake({ modelsMeta: null });
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    expect(rowOf(r.models[0].results, 'context_window')).toMatchObject({ ok: false, value: null });
  });
});

describe('probe 11 — LiteLLM /model/info fallback (audit 2026-10-06 T1-2)', () => {
  const GLM = 'api-optimize-zai-glm-5.3';
  const MODEL_INFO = { data: [
    { model_name: GLM, model_info: { max_input_tokens: 1_000_000, max_output_tokens: 131_072 } },
    { model_name: GLM, model_info: { max_input_tokens: 200_000 } },           // a second deployment — the router may pick it
    { model_name: 'api-optimize-moonshot-kimi-k3', model_info: { max_input_tokens: 262_144 } },
    { model_name: GLM, model_info: { max_input_tokens: null } },
  ] };
  const route = (handlers: Record<string, () => any>) => mockedAxios.get.mockImplementation(async (url: string) => {
    for (const [suffix, h] of Object.entries(handlers)) if (url.endsWith(suffix)) return h();
    throw httpErr(404, 'no such route');
  });
  afterEach(() => { delete process.env.CAPABILITY_DETECT_LITELLM_MODEL_INFO_DISABLED; });

  it('/v1/models carries no window → /v1/model/info max_input_tokens, MIN across the group\'s deployments', async () => {
    installFake({});
    const ep = await seed([{ id: GLM }]);
    route({ '/v1/models': () => ({ data: { data: [{ id: GLM }] } }), '/v1/model/info': () => ({ data: MODEL_INFO }) });
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    const row = rowOf(r.models[0].results, 'context_window');
    expect(row).toMatchObject({ ok: true, value: 200_000 });
    expect(row.evidence).toContain('model_info.max_input_tokens=200000');
    expect(row.evidence).toContain('min across 2 deployments');
    expect(row.evidence).not.toContain(KEY);
    expect(r.models[0].entry.contextWindow).toBe(200_000);
    expect(mockedAxios.get).toHaveBeenCalledWith(`${BASE}/model/info`, expect.objectContaining({ headers: { Authorization: `Bearer ${KEY}` } }));
  });

  it('the /v1 alias 404s → the root /model/info is tried; /models failing outright still reaches it', async () => {
    installFake({});
    const ep = await seed([{ id: GLM }]);
    route({ 'https://llm.example.com/model/info': () => ({ data: MODEL_INFO }) });
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    expect(rowOf(r.models[0].results, 'context_window')).toMatchObject({ ok: true, value: 200_000 });
    expect(mockedAxios.get).toHaveBeenCalledWith('https://llm.example.com/model/info', expect.anything());
  });

  it('no row for the model → blank, evidence names what was tried; kill switch skips the probe entirely', async () => {
    installFake({});
    const ep = await seed([{ id: 'unlisted' }]);
    route({ '/v1/models': () => ({ data: { data: [{ id: 'unlisted' }] } }), '/v1/model/info': () => ({ data: MODEL_INFO }) });
    let r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    let row = rowOf(r.models[0].results, 'context_window');
    expect(row).toMatchObject({ ok: true, value: null });
    expect(row.evidence).toContain('LiteLLM /model/info');
    process.env.CAPABILITY_DETECT_LITELLM_MODEL_INFO_DISABLED = '1';
    mockedAxios.get.mockClear();
    r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    row = rowOf(r.models[0].results, 'context_window');
    expect(row).toMatchObject({ ok: true, value: null });
    expect(row.evidence).not.toContain('model/info');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1); // /models only
  });

  it('a window on /models wins — /model/info is never called', async () => {
    installFake({ modelsMeta: { context_length: 65_536 } });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['context_window'] });
    expect(rowOf(r.models[0].results, 'context_window')).toMatchObject({ ok: true, value: 65_536 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});

describe('the whole suite on the incident model', () => {
  it('gpt-6-astra: json stream, tool_calls, cap 128, effort unsupported, no reasoning, vision refused → the entry the seat needs', async () => {
    installFake({ stream: 'json', toolCalls: 'yes', maxTools: 'cap128', effort: 'unsupported', vision: false, modelsMeta: { context_window: 400000 } });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id);
    expect(r).toMatchObject({ endpointId: ep.id, label: 'cql-litellm' });
    expect(r.models).toHaveLength(1);
    expect(r.models[0].results).toHaveLength(11);
    expect(r.models[0].entry).toMatchObject({ id: ASTRA, kind: 'chat', maxTools: 128, reasoningEffort: 'unsupported', providerClass: 'openai', contextWindow: 400000 });
    expect(r.models[0].entry.vision).toBeUndefined();
    expect(r.models[0].entry.capabilities?.results).toHaveLength(11);
    expect(r.models[0].entry.capabilities?.detectedAt).toBe(r.detectedAt);
    const reg = await resolveRegistryModel(`cql-litellm:${ASTRA}`);
    expect(reg).toMatchObject({ chatCapable: true, maxTools: 128, maxToolsSource: 'model', reasoningEffort: 'unsupported', contextWindow: 400000 });
  });
});

describe('concurrency + key hygiene', () => {
  it('probes at most 4 models at once (and really runs them in parallel)', async () => {
    let inFlight = 0; let peak = 0;
    installFake({ stream: 'json', onPost: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; } });
    const ep = await seed(Array.from({ length: 7 }, (_, i) => ({ id: `m${i}` })));
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream'] });
    expect(r.models).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(DETECT_MAX_CONCURRENT_MODELS);
    expect(peak).toBeGreaterThanOrEqual(2);
  });
  it('the API key never appears in any evidence, even when the provider echoes it', async () => {
    installFake({ toolCalls: 'effort400', stream: 'error' });
    const ep = await seed();
    const r = await detectEndpointCapabilities(ep.id, { capabilities: ['chat_stream', 'tool_calling', 'reasoning_effort'] });
    const text = JSON.stringify(r);
    expect(text).not.toContain(KEY);
    expect(rowOf(r.models[0].results, 'tool_calling').evidence).toContain('•••');
    expect(JSON.stringify(db)).not.toContain(KEY); // the stored row carries only the encrypted key
  });
  it('a probe that hangs past its timeout becomes an ok:false row, never a throw', async () => {
    jest.useFakeTimers();
    try {
      installFake({ onPost: () => new Promise(() => { /* never resolves */ }) });
      const ep = await seed();
      const pending = detectEndpointCapabilities(ep.id, { capabilities: ['vision'] });
      await jest.advanceTimersByTimeAsync(30_000);
      const r = await pending;
      const row = rowOf(r.models[0].results, 'vision');
      expect(row.ok).toBe(false);
      expect(row.evidence).toContain('did not complete');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('applyDetectionToEntry — pure', () => {
  const at = '2026-09-27T20:00:00.000Z';
  const res = (capability: string, value: any, evidence = 'e', ok = true, skipped?: boolean): DetectedCapabilityResult => ({ capability: capability as any, ok, value, evidence, latencyMs: 1, at, ...(skipped ? { skipped } : {}) });

  it('sets every flag from its probe and lists the changes', () => {
    const { entry, changed } = applyDetectionToEntry({ id: ASTRA }, [
      res('chat_stream', 'json'), res('tool_calling', true), res('max_tools', 128), res('reasoning_effort', 'unsupported'),
      res('thinking_default', true, `${THINKING_DIRECTIVE_HONOURED} (…)`), res('vision', true), res('context_window', 200000),
    ], at);
    expect(entry).toMatchObject({ id: ASTRA, kind: 'chat', maxTools: 128, reasoningEffort: 'unsupported', thinking: 'off', vision: true, contextWindow: 200000, providerClass: 'openai' });
    expect(entry.capabilities).toEqual({ detectedAt: at, results: expect.any(Array) });
    expect(changed).toEqual(expect.arrayContaining(['maxTools=128', 'reasoningEffort=unsupported', 'thinking=off', 'vision=true', 'contextWindow=200000', 'kind=chat', 'providerClass=openai']));
  });
  it('never overwrites a flag named in manualFlags; unchanged fields are not listed', () => {
    const { entry, changed } = applyDetectionToEntry(
      { id: ASTRA, maxTools: 64, reasoningEffort: 'supported', providerClass: 'other', manualFlags: ['maxTools', 'reasoningEffort'], kind: 'chat' },
      [res('max_tools', 128), res('reasoning_effort', 'unsupported'), res('chat_stream', 'json')], at,
    );
    expect(entry).toMatchObject({ maxTools: 64, reasoningEffort: 'supported', providerClass: 'other', kind: 'chat' });
    expect(changed).toEqual([]);
  });
  it('kind derivation: chat wins; else decision / image / embeddings / rerank; nothing when no probe decided', () => {
    expect(applyDetectionToEntry({ id: 'x' }, [res('chat_stream', null, 'e', false), res('typed_decisions', true)], at).entry.kind).toBe('decision');
    expect(applyDetectionToEntry({ id: 'x' }, [res('image_generation', true)], at).entry.kind).toBe('image');
    expect(applyDetectionToEntry({ id: 'x' }, [res('embeddings', 1536)], at).entry.kind).toBe('embeddings');
    expect(applyDetectionToEntry({ id: 'x' }, [res('rerank', true)], at).entry.kind).toBe('rerank');
    expect(applyDetectionToEntry({ id: 'x' }, [res('chat_stream', 'raw_text'), res('typed_decisions', true)], at).entry.kind).toBe('chat');
    expect(applyDetectionToEntry({ id: 'x', kind: 'tts' }, [res('vision', false)], at).entry.kind).toBe('tts');
    // a skipped / failed row never decides
    expect(applyDetectionToEntry({ id: 'x' }, [res('image_generation', true, 'e', true, true)], at).entry.image).toBeUndefined();
  });
  it('a stale decision flag is cleared only when the same run proved a chat model; thinking/image are never cleared; max_tools 200 sets nothing', () => {
    const base: EndpointModelEntry = { id: 'x', decision: 'systemone_chat', thinking: 'off', image: true };
    let out = applyDetectionToEntry(base, [res('typed_decisions', false)], at).entry;
    expect(out.decision).toBe('systemone_chat');
    out = applyDetectionToEntry(base, [res('typed_decisions', false), res('tool_calling', true), res('thinking_default', false), res('image_generation', false), res('max_tools', 200)], at).entry;
    expect(out.decision).toBeUndefined();
    expect(out.thinking).toBe('off');
    expect(out.image).toBe(true);
    expect(out.maxTools).toBeUndefined();
  });
  it('parseEmbeddingDims reads the probe phrasings', () => {
    expect(parseEmbeddingDims('embedding OK — 1536 dimensions')).toBe(1536);
    expect(parseEmbeddingDims('embedding OK — native 4096 dims, Matryoshka-truncated')).toBe(4096);
    expect(parseEmbeddingDims('The server REJECTED the `dimensions` parameter (HTTP 400) and natively returns 768-dimensional vectors')).toBe(768);
    expect(parseEmbeddingDims('HTTP 404')).toBeNull();
  });
});

describe('2026-09-28 — a DECISION model gets only the typed-decision probe (the owner\'s Laya 500)', () => {

  it('a model flagged decision:systemone_chat runs ONE probe (the /verify call), never a chat probe, and pins kind decision', async () => {
    const ep = await seed([{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }]);
    installFake({ stream: 'error' }); // the proxy's "'coroutine' object is not an iterator" 500 on every chat call
    mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 2, detail: 'typed decision OK (refund=yes, team=billing)' });
    const r = await detectEndpointCapabilities(ep.id, { modelId: 'agx-laya' });
    const results = r.models[0].results;
    expect(results.map((x) => x.capability)).toEqual(['decision']);
    expect(rowOf(results, 'decision')).toMatchObject({ ok: true, value: true, evidence: expect.stringContaining('chat capabilities not applicable') });
    expect(mockProbeSystemOne).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: BASE, apiKey: KEY, model: 'agx-laya', transport: 'chat' }));
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(r.models[0].entry).toMatchObject({ decision: 'systemone_chat', kind: 'decision', maxStateChars: 3800 });
    expect(r.models[0].entry.capabilities?.results.map((x) => x.capability)).toEqual(['decision']);
  });

  it('a failed decision probe is an ok:false row with the reason — never a throw, never a chat probe', async () => {
    const ep = await seed([{ id: 'agx-laya', kind: 'decision' }]);
    installFake({});
    mockProbeSystemOne.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 2, error: `HTTP 401 (key ${KEY})` });
    const r = await detectEndpointCapabilities(ep.id, { modelId: 'agx-laya' });
    expect(rowOf(r.models[0].results, 'decision')).toMatchObject({ ok: false, value: null });
    expect(rowOf(r.models[0].results, 'decision').evidence).not.toContain(KEY);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('a chat model on the same endpoint keeps the full suite and never runs the decision probe', async () => {
    const ep = await seed([{ id: ASTRA }, { id: 'agx-laya', decision: 'systemone_chat' }]);
    installFake({ toolCalls: 'yes', maxTools: 'ok', effort: 'ok' });
    mockProbeSystemOne.mockResolvedValue({ ok: true, target: 't', latencyMs: 2, detail: 'ok' });
    const r = await detectEndpointCapabilities(ep.id, {});
    const astra = r.models.find((m) => m.id === ASTRA)!;
    const laya = r.models.find((m) => m.id === 'agx-laya')!;
    expect(astra.results.map((x) => x.capability)).not.toContain('decision');
    expect(astra.results.map((x) => x.capability)).toContain('chat_stream');
    expect(laya.results.map((x) => x.capability)).toEqual(['decision']);
  });
});
