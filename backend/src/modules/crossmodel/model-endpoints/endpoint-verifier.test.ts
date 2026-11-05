/**
 * endpoint-verifier — the per-model PARSE verification battery (owner
 * directive 2026-09-15: self-hosted GPU nodes, e.g. a Nebius B300, are
 * first-class admin-selectable fallbacks, so the admin must be able to prove
 * a served model PARSES before seating it).
 *
 * verifyEndpointModel('<label>:<modelId>') runs FOUR sequential probes —
 * chat_stream (the deep full-SSE parse probe), utility (the real
 * non-streaming helper shape), embeddings (1536-dim contract), rerank
 * (Cohere-style) — and returns one { ok, latencyMs, detail?, error? } row per
 * shape. The battery NEVER throws past the AppError(400) for an unresolvable
 * spec, and the API key never appears in any result (scrubError).
 *
 * Boundary mocks mirror model-roles.service.test.ts: endpoint-verifier
 * imports model-roles.service eagerly (its probes + authHeaders + scrubError
 * run REAL here — highest fidelity), so every boundary that module touches is
 * stubbed. coding-model is partial-mocked (requireActual proves it is
 * jest-loadable; resolveProviderForRun/seatServability stubbed);
 * helper-completion stays REAL so the chat_stream probe's <think> strip IS
 * Digby's own stripLeadingThink. The SSE stream is simulated with an
 * EventEmitter (the model-roles.service.test.ts idiom).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

const mockStoreGet = jest.fn();
const mockStorePut = jest.fn(async (..._a: any[]) => {});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

const mockResolveRegistryModel = jest.fn();
jest.mock('./model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

const mockPrefFindUnique = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userPreferences: { findUnique: (...a: any[]) => mockPrefFindUnique(...a) } },
}));

const mockResolveOneCodingPick = jest.fn();
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: (...a: any[]) => mockResolveOneCodingPick(...a),
}));

// coding-model is partial-mocked: the pure helpers helper-completion needs
// (THINKING_OFF_EXTRA / DEEPSEEK_THINKING_OFF_EXTRA / isDeepSeekBuiltInProvider)
// stay REAL; only the run-path resolution + servability are stubbed.
const mockResolveProviderForRun = jest.fn();
const mockSeatServability = jest.fn(async (..._a: any[]): Promise<{ reason: string | null; missingEnvKey?: string }> => ({ reason: null }));
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  resolveProviderForRun: (...a: any[]) => mockResolveProviderForRun(...a),
  seatServability: (...a: any[]) => mockSeatServability(...(a as [])),
}));

const mockCountSeatFallbacks = jest.fn(async (..._a: any[]): Promise<Record<string, number>> => ({}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  countSeatFallbacksByRole: (...a: any[]) => mockCountSeatFallbacks(...a),
}));

// Laya follow-up (2026-09-26): a decision model (systemone / systemone_chat shape, or the per-model
// decision:'systemone_chat' flag on an openai_chat endpoint) is verified with ONE typed-decision probe through the
// decision gate's own client (dynamic import) instead of the four-shape battery — mocked here.
const mockProbeSystemOne = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: true, target: 't', latencyMs: 4, detail: 'typed decision OK' }));
// Review 3c18284e (condition 6): the runtime's LEARNED typed-decision latch, mirrored locally —
// the verifier consults isTypedDecisionSpec + the latch arm of registryDecisionTransport.
const mockLatchedTypedDecisionSpecs = new Set<string>();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  probeSystemOneServer: (...a: any[]) => mockProbeSystemOne(...a),
  // Ticket 2df5ed65: verifyEndpointModel resolves the transport through the
  // same single source of truth as the run path (shape > flag > kind > latch).
  registryDecisionTransport: (reg: { providerShape?: unknown; decision?: unknown; kind?: unknown }, latchedSpec?: string) =>
    reg.providerShape === 'systemone' ? 'systemone'
      : (reg.providerShape === 'systemone_chat' || reg.decision === 'systemone_chat' || reg.kind === 'decision') ? 'chat'
        : (latchedSpec && mockLatchedTypedDecisionSpecs.has(latchedSpec)) ? 'chat'
          : null,
  isTypedDecisionSpec: (spec: string) => mockLatchedTypedDecisionSpecs.has(String(spec || '')),
  latchTypedDecisionSpec: (spec: string) => { mockLatchedTypedDecisionSpecs.add(String(spec || '').trim()); },
  clearTypedDecisionLatch: () => { mockLatchedTypedDecisionSpecs.clear(); },
}));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { EventEmitter } from 'events';
import { verifyEndpointModel } from './endpoint-verifier';

const SPEC = 'nebius-b300:Qwen/Qwen3-32B';

/** Registry resolution for the Nebius B300 node (the endpoint-verifier
 *  preflight gate AND the embeddings/rerank probes' nonChatTarget). */
const REG = {
  url: 'http://10.0.0.8:8000/v1/chat/completions',
  baseUrl: 'http://10.0.0.8:8000/v1',
  apiKey: 'sk-nebius',
  model: 'Qwen/Qwen3-32B',
  label: 'nebius-b300',
  supportsVision: false,
  coding: true,
  matryoshka: false,
  thinkingOff: false,
};

/** The run-path provider the chat_stream/utility probes resolve to. */
const PROVIDER = {
  url: 'http://10.0.0.8:8000/v1/chat/completions',
  apiKey: 'sk-nebius',
  model: 'Qwen/Qwen3-32B',
  label: 'nebius-b300 (custom endpoint)',
  extra: {},
  omitParams: [] as string[],
};

/**
 * URL-discriminating axios mock for the four probes. The streaming chat probe
 * gets an EventEmitter SSE stream whose frames are emitted (chunked per the
 * caller) on a 5ms timer; the other probes resolve plain JSON. Rejection
 * shapes are customized per test by re-calling with different `overrides`.
 */
function mockAllProbes(overrides?: {
  streamFrames?: string[] | null;
  streamEnd?: 'end' | 'error' | 'never';
  utility?: { resolve?: any; reject?: any };
  embeddings?: { resolve?: any; reject?: any };
  rerank?: { resolve?: any; reject?: any };
}) {
  const frames = overrides?.streamFrames === undefined
    ? [
      'data: {"choices":[{"delta":{"content":"O"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"K"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    : overrides.streamFrames;
  mockedAxios.post.mockImplementation(async (url: string, payload: any) => {
    if (url.includes('/chat/completions') && payload?.stream === true) {
      const stream: any = new EventEmitter();
      stream.destroy = jest.fn();
      setTimeout(() => {
        for (const f of frames ?? []) stream.emit('data', Buffer.from(f));
        const end = overrides?.streamEnd ?? 'end';
        if (end === 'end') stream.emit('end');
        else if (end === 'error') stream.emit('error', new Error('boom'));
        // 'never': the stream hangs — the probe's own 20s timer is the stopper
        // (not exercised in these tests: jest would wait it out).
      }, 5);
      return { data: stream } as any;
    }
    if (url.includes('/chat/completions')) {
      if (overrides?.utility?.reject) throw overrides.utility.reject;
      return (overrides?.utility?.resolve ?? { data: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } }) as any;
    }
    if (url.includes('/embeddings')) {
      if (overrides?.embeddings?.reject) throw overrides.embeddings.reject;
      return (overrides?.embeddings?.resolve ?? { data: { data: [{ embedding: new Array(1536).fill(0.1) }] } }) as any;
    }
    if (url.includes('/rerank')) {
      if (overrides?.rerank?.reject) throw overrides.rerank.reject;
      return (overrides?.rerank?.resolve ?? { data: { results: [{ index: 0, relevance_score: 0.9 }] } }) as any;
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

beforeEach(() => {
  jest.resetAllMocks(); // implementations too — persistent mockResolvedValue must not leak across tests
  mockResolveRegistryModel.mockResolvedValue(REG);
  mockResolveProviderForRun.mockResolvedValue(PROVIDER);
  mockStoreGet.mockResolvedValue(null);
  mockStorePut.mockResolvedValue(undefined as any);
  mockSeatServability.mockResolvedValue({ reason: null });
  mockPrefFindUnique.mockResolvedValue(null);
  mockResolveOneCodingPick.mockResolvedValue(null);
  mockCountSeatFallbacks.mockResolvedValue({});
});

describe('verifyEndpointModel — the four-shape parse battery (Nebius B300)', () => {
  it('all four shapes green: 4 rows in order chat_stream→utility→embeddings→rerank, posted SEQUENTIALLY in that order, with the pinned probe payloads + auth header', async () => {
    mockAllProbes();
    const result = await verifyEndpointModel(SPEC);

    expect(result.model).toBe(SPEC);
    expect(result.results.map(r => r.shape)).toEqual(['chat_stream', 'utility', 'embeddings', 'rerank']);
    expect(result.results).toHaveLength(4);
    for (const row of result.results) expect(row.ok).toBe(true);
    expect(result.results[0].detail).toMatch(/stream parse OK/);
    expect(result.results[0].detail).toContain('finish_reason=stop');
    expect(result.results[1].detail).toContain('non-streaming completion OK');
    expect(result.results[2].detail).toContain('1536');
    expect(result.results[3].detail).toContain('rerank OK');

    // SEQUENTIAL, one POST per probe, in battery order (axios.post call order
    // proves it — a single-GPU node must never be parallel-hit).
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);
    const calls = mockedAxios.post.mock.calls;
    expect(String(calls[0][0])).toBe('http://10.0.0.8:8000/v1/chat/completions');
    expect(String(calls[1][0])).toBe('http://10.0.0.8:8000/v1/chat/completions');
    expect(String(calls[2][0])).toBe('http://10.0.0.8:8000/v1/embeddings');
    expect(String(calls[3][0])).toBe('http://10.0.0.8:8000/v1/rerank');

    // The chat_stream probe payload: stream:true, max_tokens 64 (the deep
    // parse probe's budget), Bearer auth from the endpoint key.
    const streamPayload = calls[0][1] as any;
    expect(streamPayload.stream).toBe(true);
    expect(streamPayload.max_tokens).toBe(64);
    expect(streamPayload.model).toBe('Qwen/Qwen3-32B');
    expect((calls[0][2] as any).headers.Authorization).toBe('Bearer sk-nebius');
    expect((calls[0][2] as any).responseType).toBe('stream');
    // The utility probe is the NON-streaming helper shape (no stream flag).
    const utilityPayload = calls[1][1] as any;
    expect(utilityPayload.stream).toBeUndefined();
    expect(utilityPayload.model).toBe('Qwen/Qwen3-32B');
    expect((calls[1][2] as any).headers.Authorization).toBe('Bearer sk-nebius');
    // The endpoint key never appears anywhere in the returned battery.
    expect(JSON.stringify(result)).not.toContain('sk-nebius');
  });

  it('chat_stream: an invalid-JSON SSE frame fails the shape, naming the frame', async () => {
    mockAllProbes({
      streamFrames: [
        'data: {"choices":[{"delta":{"content":"O"}}]}\n\n',
        'data: {not json}\n\n',
      ],
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[0];
    expect(row.shape).toBe('chat_stream');
    expect(row.ok).toBe(false);
    expect(row.error).toContain('is not valid JSON');
    expect(row.error).toContain('frame #2');
    // A failed shape never breaks the battery — the other probes still ran.
    expect(result.results).toHaveLength(4);
    expect(result.results.slice(1).every(r => r.ok)).toBe(true);
  });

  it('chat_stream: a reasoning-only stream (finish_reason length) fails with the "spent the budget thinking … flag no-think" guidance', async () => {
    mockAllProbes({
      streamFrames: [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking hard…"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"…still thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[0];
    expect(row.ok).toBe(false);
    expect(row.error).toContain('spent the budget thinking');
    expect(row.error).toContain('"no-think"');
    expect(JSON.stringify(result)).not.toContain('sk-nebius');
  });

  it('chat_stream: a stream that ends without finish_reason/[DONE] fails naming the missing terminator', async () => {
    mockAllProbes({
      streamFrames: [
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      ],
      streamEnd: 'end',
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[0];
    expect(row.ok).toBe(false);
    expect(row.error).toContain('finish_reason');
  });

  it('chat_stream: Digby\'s REAL <think> strip runs on the accumulated answer (a leading think block is never prose)', async () => {
    mockAllProbes({
      streamFrames: [
        'data: {"choices":[{"delta":{"content":"<think>abc</think>OK"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[0];
    expect(row.ok).toBe(true);
    // The stripped answer is 'OK' — 2 chars, reported in the detail line.
    // A duplicated/naive strip would report 17 (helper-completion stays REAL).
    expect(row.detail).toContain('answer 2 chars after think-strip');
  });

  it('utility shape failure is key-scrubbed — the endpoint key never appears in the battery', async () => {
    mockAllProbes({
      utility: { reject: { response: { status: 500, statusText: 'Internal Server Error', data: { error: 'boom sk-nebius' } }, message: 'boom sk-nebius' } },
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[1];
    expect(row.shape).toBe('utility');
    expect(row.ok).toBe(false);
    expect(row.error).toContain('HTTP 500');
    expect(JSON.stringify(result)).not.toContain('sk-nebius');
    // The remaining shapes still ran green.
    expect(result.results[0].ok).toBe(true);
    expect(result.results[2].ok).toBe(true);
    expect(result.results[3].ok).toBe(true);
  });

  it('embeddings: a 768-dim vector fails the 1536-dim contract with the dims-mismatch verdict', async () => {
    mockAllProbes({
      embeddings: { resolve: { data: { data: [{ embedding: new Array(768).fill(0.1) }] } } },
    });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[2];
    expect(row.shape).toBe('embeddings');
    expect(row.ok).toBe(false);
    expect(row.error).toContain('768');
    expect(row.error).toContain('1536');
    expect(row.error).toContain('dimensions');
  });

  it('an unresolvable spec rejects AppError(400) BEFORE any probe runs', async () => {
    mockResolveRegistryModel.mockResolvedValue(null);
    await expect(verifyEndpointModel('ghost:model')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('does not resolve'),
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('chat_stream: a runaway stream is cut at the byte cap (F2 — unproven servers must not balloon the API heap)', async () => {
    // 5 × 1 MB of non-SSE garbage: the cap check fires on the 5th chunk,
    // before any parsing, and destroys the stream.
    const meg = 'x'.repeat(1024 * 1024);
    mockAllProbes({ streamFrames: [meg, meg, meg, meg, meg], streamEnd: 'never' });
    const result = await verifyEndpointModel(SPEC);
    const row = result.results[0];
    expect(row.shape).toBe('chat_stream');
    expect(row.ok).toBe(false);
    expect(row.error).toContain('exceeded');
    expect(row.error).toContain('not a well-formed chat-completions stream');
    // The battery continued — the other three shapes still ran green.
    expect(result.results[1].ok).toBe(true);
    expect(result.results[2].ok).toBe(true);
    expect(result.results[3].ok).toBe(true);
  });
});

describe('verifyEndpointModel — decision models (Laya follow-up, 2026-09-26)', () => {
  // The file-level beforeEach resetAllMocks() wipes the mock's implementation — re-arm the probe per test.
  beforeEach(() => { mockProbeSystemOne.mockResolvedValue({ ok: true, target: 't', latencyMs: 4, detail: 'typed decision OK' }); });

  it('a model flagged decision:"systemone_chat" on an openai_chat endpoint (cql-litellm:agx-laya) gets ONE typed-decision probe over the chat transport — the four-shape battery (which the proxy 400s) never runs', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, label: 'cql-litellm', model: 'agx-laya', coding: false, baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', providerShape: 'openai_chat', decision: 'systemone_chat', maxStateChars: 3800 });
    const result = await verifyEndpointModel('cql-litellm:agx-laya');
    expect(result).toEqual({ model: 'cql-litellm:agx-laya', results: [{ shape: 'decision', ok: true, latencyMs: 4, detail: 'typed decision OK' }] });
    expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('a systemone_chat-shape endpoint model probes over the chat transport; a systemone-shape one over /systemone; an unflagged openai_chat model still runs the four-shape battery', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, providerShape: 'systemone_chat' });
    await verifyEndpointModel(SPEC);
    expect(mockProbeSystemOne).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'chat' }));
    mockResolveRegistryModel.mockResolvedValue({ ...REG, providerShape: 'systemone' });
    await verifyEndpointModel(SPEC);
    expect(mockProbeSystemOne).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'systemone' }));
    expect(mockedAxios.post).not.toHaveBeenCalled();
    mockProbeSystemOne.mockClear();
    mockResolveRegistryModel.mockResolvedValue({ ...REG, providerShape: 'openai_chat' });
    mockAllProbes();
    const result = await verifyEndpointModel(SPEC);
    expect(result.results.map(r => r.shape)).toEqual(['chat_stream', 'utility', 'embeddings', 'rerank']);
    expect(mockProbeSystemOne).not.toHaveBeenCalled();
  });

  it('a probe that throws is a scrubbed ok:false decision row, never a rejection', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, providerShape: 'openai_chat', decision: 'systemone_chat' });
    mockProbeSystemOne.mockRejectedValueOnce(new Error('boom Bearer sk-nebius'));
    const result = await verifyEndpointModel(SPEC);
    expect(result.results[0]).toMatchObject({ shape: 'decision', ok: false });
    expect(JSON.stringify(result)).not.toContain('sk-nebius');
  });

  // Review 3c18284e (condition 6): the LEARNED latch reaches the Verify button — an unflagged
  // openai_chat spec this process learned is typed-decision (guard 400 on its logit leg) gets
  // the ONE typed-decision probe over the chat transport, not the four-shape battery that
  // "verified broken while healthy".
  it('an UNFLAGGED model whose spec the runtime LATCHED as typed-decision (ticket 3c18284e: guard 400 observed on its logit leg) verifies over the chat transport — the four-shape battery never runs; unlatched, the same spec runs the battery', async () => {
    mockLatchedTypedDecisionSpecs.clear();
    mockResolveRegistryModel.mockResolvedValue({ ...REG, label: 'cql-llm', model: 'agx-laya', coding: false, baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', providerShape: 'openai_chat' });
    mockProbeSystemOne.mockClear();
    mockLatchedTypedDecisionSpecs.add('cql-llm:agx-laya');
    const result = await verifyEndpointModel('cql-llm:agx-laya');
    expect(result).toEqual({ model: 'cql-llm:agx-laya', results: [{ shape: 'decision', ok: true, latencyMs: 4, detail: 'typed decision OK' }] });
    expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    // Unlatched (the admin reset): the same unflagged spec is the plain chat battery again.
    mockLatchedTypedDecisionSpecs.clear();
    mockProbeSystemOne.mockClear();
    mockAllProbes();
    const result2 = await verifyEndpointModel('cql-llm:agx-laya');
    expect(result2.results.map(r => r.shape)).toEqual(['chat_stream', 'utility', 'embeddings', 'rerank']);
    expect(mockProbeSystemOne).not.toHaveBeenCalled();
  });

  it('ticket 2df5ed65 — a DECISION-KIND model (unflagged, kind "decision" or a decision id like agx-laya) gets the ONE typed-decision probe too, never the four-shape chat battery: the battery\'s plain call draws its usage-guide 400 and a healthy model verified "broken"', async () => {
    // kind:'decision' from modelKindOf (explicit kind or the id heuristic) — no decision flag, no dedicated shape.
    mockResolveRegistryModel.mockResolvedValue({ ...REG, label: 'cql-litellm', model: 'agx-laya', coding: false, baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', providerShape: 'openai_chat', kind: 'decision' });
    const result = await verifyEndpointModel('cql-litellm:agx-laya');
    expect(result).toEqual({ model: 'cql-litellm:agx-laya', results: [{ shape: 'decision', ok: true, latencyMs: 4, detail: 'typed decision OK' }] });
    expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
