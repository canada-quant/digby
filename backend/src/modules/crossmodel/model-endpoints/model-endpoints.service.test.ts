/**
 * model-endpoints.service — Digby Edge (Phase 2) registry.
 * Pins: create/update validation (shape, URL, label, models), apiKey
 * encryption at rest + never serialized, per-owner label uniqueness, the
 * apiKey patch semantics (omitted = unchanged, '' = clear), the connectivity
 * check (axios mocked; GET /models + the POST /chat/completions auth probe
 * with bounded per-model fallback, ticket 1dc89d48; the key never leaks into
 * errors), draft probing for
 * model auto-discovery (key precedence: explicit > stored > none), and the
 * run-path registry resolution (spec parsing, cache, disabled rows ignored).
 * Prisma mocked in the credentials.service.test.ts style.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler.ts (AppError) pulls config/env, which exits the jest worker at
// import — stand it in (same boundary the other crossmodel tests use).
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

const db: any[] = [];
let nextId = 1;
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    modelEndpoint: {
      findMany: jest.fn(async () => [...db].sort((a, b) => a.label.localeCompare(b.label))),
      findUnique: jest.fn(async ({ where }: any) => db.find(r => r.id === where.id) || null),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        let rows = db.filter(r => {
          if (where.label !== undefined && r.label !== where.label) return false;
          if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
          if (where.ownerUserId !== undefined && r.ownerUserId !== where.ownerUserId) return false;
          if (where.id?.not !== undefined && r.id === where.id.not) return false;
          if (where.OR) {
            const ok = where.OR.some((c: any) => r.ownerUserId === (c.ownerUserId ?? null));
            if (!ok) return false;
          }
          return true;
        });
        if (orderBy?.ownerUserId === 'asc') {
          rows = rows.sort((a, b) => (a.ownerUserId === null ? 0 : 1) - (b.ownerUserId === null ? 0 : 1));
        }
        return rows[0] || null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `e${nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.push(row); return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const i = db.findIndex(r => r.id === where.id);
        if (i < 0) throw new Error('not found');
        db[i] = { ...db[i], ...data, updatedAt: new Date() };
        return db[i];
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = db.length;
        for (let i = db.length - 1; i >= 0; i--) if (db[i].id === where.id) db.splice(i, 1);
        return { count: before - db.length };
      }),
    },
  },
}));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Laya follow-up (2026-09-26): the decision probe the systemone / systemone_chat connectivity check runs through the
// decision gate's own client (dynamic import) — mocked so no loop-metrics / config boots here.
const mockProbeSystemOne = jest.fn(async (..._a: any[]): Promise<any> => ({ ok: true, target: 't', latencyMs: 3, detail: 'probe ok' }));
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  probeSystemOneServer: (...a: any[]) => mockProbeSystemOne(...a),
}));

import {
  createEndpoint, listEndpoints, updateEndpoint, deleteEndpoint,
  testEndpointConnection, probeEndpointModels, resolveRegistryModel, parseRegistrySpec,
  clearRegistryModelCache, normalizeBaseUrl, isChatCapableEntry, refreshEndpointModels,
  IMAGE_MODEL_TIMEOUT_MIN_MS, IMAGE_MODEL_TIMEOUT_MAX_MS,
} from './model-endpoints.service';
import prisma from '../../../config/database';

const VALID = {
  label: 'my-ollama',
  providerShape: 'openai_chat',
  baseUrl: 'http://192.168.1.50:11434/v1',
  models: [{ id: 'qwen3:32b', coding: true }],
};

beforeEach(() => {
  db.length = 0;
  nextId = 1;
  clearRegistryModelCache();
  jest.clearAllMocks();
});

describe('createEndpoint validation', () => {
  it('creates an instance-wide endpoint and sanitizes the key out of the summary', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-secret-1234' });
    expect(ep.label).toBe('my-ollama');
    expect(ep.ownerUserId).toBeNull();
    expect(ep.hasApiKey).toBe(true);
    // Never serialized — not the key, not the ciphertext field.
    expect(JSON.stringify(ep)).not.toContain('sk-secret-1234');
    expect(JSON.stringify(ep)).not.toContain('apiKeyEnc');
    // Encrypted at rest — the stored row is not plaintext.
    expect(db[0].apiKeyEnc).toBeTruthy();
    expect(db[0].apiKeyEnc).not.toContain('sk-secret-1234');
  });

  it('stores baseUrl without a trailing slash', async () => {
    const ep = await createEndpoint({ ...VALID, baseUrl: 'http://192.168.1.50:11434/v1/' });
    expect(ep.baseUrl).toBe('http://192.168.1.50:11434/v1');
  });

  it('rejects unsupported providerShape with a clear 400', async () => {
    await expect(createEndpoint({ ...VALID, providerShape: 'anthropic' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('openai_chat') });
  });

  it('rejects bad baseUrls (not a URL, non-http scheme)', async () => {
    await expect(createEndpoint({ ...VALID, baseUrl: 'not-a-url' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createEndpoint({ ...VALID, baseUrl: 'ftp://host/v1' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('http') });
  });

  it('rejects empty/duplicate model lists and bad labels', async () => {
    await expect(createEndpoint({ ...VALID, models: [] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('At least one model') });
    await expect(createEndpoint({ ...VALID, models: [{ id: 'a' }, { id: 'a' }] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Duplicate') });
    await expect(createEndpoint({ ...VALID, label: 'has:colon' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createEndpoint({ ...VALID, label: 'Has Spaces' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces per-owner label uniqueness (409)', async () => {
    await createEndpoint(VALID);
    await expect(createEndpoint(VALID))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('my-ollama') });
  });
});

describe('updateEndpoint', () => {
  it('keeps the stored key when apiKey is omitted; re-encrypts on a new value; clears on ""', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-one' });
    const enc1 = db[0].apiKeyEnc;

    const afterNoop = await updateEndpoint(ep.id, { baseUrl: 'http://10.0.0.2:11434/v1' });
    expect(db[0].apiKeyEnc).toBe(enc1);
    expect(afterNoop.hasApiKey).toBe(true);

    await updateEndpoint(ep.id, { apiKey: 'sk-two' });
    expect(db[0].apiKeyEnc).not.toBe(enc1);
    expect(db[0].apiKeyEnc).not.toContain('sk-two');

    const afterClear = await updateEndpoint(ep.id, { apiKey: '' });
    expect(db[0].apiKeyEnc).toBeNull();
    expect(afterClear.hasApiKey).toBe(false);
  });

  it('rejects a label clash with another endpoint and 404s unknown ids', async () => {
    await createEndpoint(VALID);
    const other = await createEndpoint({ ...VALID, label: 'second' });
    await expect(updateEndpoint(other.id, { label: 'my-ollama' }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(updateEndpoint('nope', { baseUrl: 'http://x/v1' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listEndpoints / deleteEndpoint', () => {
  it('lists sanitized summaries sorted by label and deletes by id', async () => {
    await createEndpoint({ ...VALID, label: 'b-endpoint' });
    await createEndpoint({ ...VALID, label: 'a-endpoint', apiKey: 'sk-x' });
    const rows = await listEndpoints();
    expect(rows.map(r => r.label)).toEqual(['a-endpoint', 'b-endpoint']);
    expect(JSON.stringify(rows)).not.toContain('sk-x');
    expect(JSON.stringify(rows)).not.toContain('apiKeyEnc');
    expect(rows[0].hasApiKey).toBe(true);
    expect(rows[1].hasApiKey).toBe(false);

    expect(await deleteEndpoint(rows[0].id)).toBe(true);
    expect(await deleteEndpoint(rows[0].id)).toBe(false);
    expect((await listEndpoints()).map(r => r.label)).toEqual(['b-endpoint']);
  });
});

describe('testEndpointConnection', () => {
  it('returns ok + model ids and sends the decrypted key', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'qwen3:32b' }, { id: 'llava:13b' }] } } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result).toEqual({ ok: true, models: ['qwen3:32b', 'llava:13b'], completionAuth: 'ok' });
    const [url, opts] = mockedAxios.get.mock.calls[0];
    expect(url).toBe('http://192.168.1.50:11434/v1/models');
    expect((opts as any).headers.Authorization).toBe('Bearer sk-live-key');
    expect((opts as any).timeout).toBe(5000);
  });

  it('probes POST /chat/completions against the first listed model (1 token, no stream) when a key is set', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'qwen3:32b' }, { id: 'llava:13b' }] } } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'x' } }] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result.completionAuth).toBe('ok');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.50:11434/v1/chat/completions');
    expect(body).toMatchObject({ model: 'qwen3:32b', max_tokens: 1, stream: false });
    expect((opts as any).headers.Authorization).toBe('Bearer sk-live-key');
    expect((opts as any).timeout).toBe(5000);
  });

  it('falls back past a dead first-listed model: the second model answers the probe (ticket 1dc89d48 replay)', async () => {
    // The incident shape: LiteLLM lists 8 routes, the first has no live
    // engine (5s timeout), the rest answer in <2s — discovery must succeed
    // and name the answering model, not fail the whole fetch on model #1.
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'kimi-k3' }, { id: 'glm-5.3' }, { id: 'deepseek-flash' }] } } as any);
    mockedAxios.post
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' })
      .mockResolvedValueOnce({ data: { choices: [] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result).toEqual({
      ok: true,
      models: ['kimi-k3', 'glm-5.3', 'deepseek-flash'],
      completionAuth: 'ok',
      probedModel: 'glm-5.3',
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ model: 'kimi-k3' });
    expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({ model: 'glm-5.3' });
  });

  it('succeeds via fallback when the first model 404s (dead route) and the second answers', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'dead-route' }, { id: 'live-route' }] } } as any);
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 404, statusText: 'Not Found' }, message: 'Request failed with status code 404' })
      .mockResolvedValueOnce({ data: { choices: [] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(true);
    expect(result.completionAuth).toBe('ok');
    expect(result.probedModel).toBe('live-route');
  });

  it('names probedModel when a DUPLICATE of the first model id answers at a later index (ticket f380838a replay)', async () => {
    // Exotic provider list: the same model id appears twice within the first
    // PROBE_MAX_ATTEMPTS entries and the second occurrence is the one that
    // answers. The old value-based first-success check (model === attempts[0])
    // treated that as a first-model hit and omitted probedModel; the
    // index-based check names it.
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'dup-route' }, { id: 'dup-route' }, { id: 'other-route' }] } } as any);
    mockedAxios.post
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' })
      .mockResolvedValueOnce({ data: { choices: [] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result).toEqual({
      ok: true,
      models: ['dup-route', 'dup-route', 'other-route'],
      completionAuth: 'ok',
      probedModel: 'dup-route',
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ model: 'dup-route' });
    expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({ model: 'dup-route' });
  });

  it('probes at most 3 models and names every probed model when all fail', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }, { id: 'm5' }] } } as any);
    mockedAxios.post
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' })
      .mockRejectedValueOnce({ response: { status: 500, statusText: 'Internal Server Error' }, message: 'Request failed with status code 500' })
      .mockRejectedValueOnce({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(false);
    expect(result.completionAuth).toBe('failed');
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    expect(result.error).toContain('models list OK');
    expect(result.error).toContain('all 3 probed model(s)');
    expect(result.error).toContain('m1 (Timed out');
    expect(result.error).toContain('m2 (HTTP 500');
    expect(result.error).toContain('m3 (Unreachable');
    expect(result.error).not.toContain('check the key');
  });

  it('keeps the check-the-key hint when a later fallback attempt got 401/403 — and still never leaks the key', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-do-not-leak' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'm1' }, { id: 'm2' }] } } as any);
    mockedAxios.post
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' })
      .mockRejectedValueOnce({
        response: { status: 401, statusText: 'Unauthorized' },
        message: 'Request failed with status code 401 (invalid key sk-do-not-leak)',
      });
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(false);
    expect(result.completionAuth).toBe('failed');
    expect(result.error).toContain('all 2 probed model(s)');
    expect(result.error).toContain('check the key');
    expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
  });

  it('reports a 401 on chat/completions distinctly even though /models succeeded — never leaking the key', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-do-not-leak' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'qwen3:32b' }] } } as any);
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, statusText: 'Unauthorized' },
      message: 'Request failed with status code 401 (invalid key sk-do-not-leak)',
    });
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(false);
    expect(result.completionAuth).toBe('failed');
    expect(result.models).toEqual(['qwen3:32b']);
    expect(result.error).toContain('models list OK');
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toContain('check the key');
    expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
  });

  it('reports non-auth completion failures without the check-the-key hint', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'qwen3:32b' }] } } as any);
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 400, statusText: 'Bad Request' },
      message: 'Request failed with status code 400',
    });
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(false);
    expect(result.completionAuth).toBe('failed');
    expect(result.error).toContain('models list OK');
    expect(result.error).toContain('HTTP 400');
    expect(result.error).not.toContain('check the key');
  });

  it('skips the completion probe when the models list is empty even with a key set', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-live-key' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result).toEqual({ ok: true, models: [] });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('sends NO Authorization header when the endpoint has no key — and skips the completion probe', async () => {
    const ep = await createEndpoint(VALID);
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } } as any);
    await testEndpointConnection(ep.id);
    const [, opts] = mockedAxios.get.mock.calls[0];
    expect((opts as any).headers.Authorization).toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('reduces HTTP failures to a status and never leaks the key', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-do-not-leak' });
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 401, statusText: 'Unauthorized' },
      message: 'Request failed with status code 401',
    });
    const result = await testEndpointConnection(ep.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
  });

  it('maps timeouts and unreachable hosts to friendly errors', async () => {
    const ep = await createEndpoint(VALID);
    mockedAxios.get.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' });
    expect((await testEndpointConnection(ep.id)).error).toContain('Timed out');
    mockedAxios.get.mockRejectedValueOnce({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    expect((await testEndpointConnection(ep.id)).error).toContain('Unreachable');
  });

  it('404s unknown ids', async () => {
    await expect(testEndpointConnection('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── Ticket 2df5ed65 — the false-400 on healthy typed-decision endpoints ──
  // The owner pressed Test on a LiteLLM openai_chat endpoint whose decision
  // route (agx-laya) 400s a plain chat call with a typed-decision usage guide.
  // The endpoint was healthy; the Test button rendered it broken. These tests
  // replay the incident shape and pin the rescued verdicts.
  describe('ticket 2df5ed65 — kind-aware Test on typed-decision routes', () => {
    beforeEach(() => {
      // Kind-aware walks can SKIP the chat probe entirely (an all-decision
      // list), leaving queued mock values unconsumed — a leak that cascades
      // into later suites (jest.clearAllMocks does not drop Once queues).
      // Reset the axios + decision-probe queues around every test here.
      mockedAxios.post.mockReset();
      mockedAxios.get.mockReset();
      mockProbeSystemOne.mockReset();
      mockProbeSystemOne.mockImplementation(async () => ({ ok: true, target: 't', latencyMs: 3, detail: 'probe ok' }));
    });
    afterEach(() => {
      mockedAxios.post.mockReset();
      mockedAxios.get.mockReset();
      mockProbeSystemOne.mockReset();
      mockProbeSystemOne.mockImplementation(async () => ({ ok: true, target: 't', latencyMs: 3, detail: 'probe ok' }));
    });

    it('REPLAY (the incident): an UNDECLARED decision route 400s the chat probe with its usage guide — the decision-shape re-probe rescues it to ok with the fix hint, never a failure', async () => {
      // The registry carries the id with the CHAT-CATALOG SYNC flag (coding:
      // true — the raw LiteLLM /v1/models sync shape), so the row reads it as
      // a chat model and the walk probes it — drawing the usage-guide 400.
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-cql', models: [{ id: 'agx-laya', coding: true }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
      // The 1-token chat probe draws the live usage guide (verbatim shape from
      // the llm.cql.ca gateway, probe lane fea91f9e 2026-10-20).
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: { message: 'agx-laya is a typed-decision model, not a chat model. Send "questions": {key: {"instructions": str, "type": "choice"|"noul"|"score", "criteria": [..]}} and a user message (the state) in the request body.' } },
        },
        message: 'Request failed with status code 400',
      } as any);
      // The decision-shape re-probe passes (the endpoint is healthy).
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 'llm.cql.ca (typed decisions via chat completions)', latencyMs: 211, detail: '/chat/completions (typed-decision proxy) OK on agx-laya in 211 ms — refund noul 0.90, team "billing"' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(true);
      expect(result.completionAuth).toBe('ok');
      expect(result.models).toEqual(['agx-laya']);
      expect(result.detail).toContain('typed-decision model, not a chat model');
      expect(result.detail).toContain('not a broken endpoint');
      // The undeclared case tells the admin to tick the flag.
      expect(result.detail).toContain('Tick [typed decisions]');
      expect(result.detail).toContain('refund noul 0.90');
      // The re-probe went through the decision gate's client over the chat transport.
      expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: VALID.baseUrl, apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    });

    it('a DECLARED decision model (flagged [typed decisions]) is skipped by the chat walk — a chat sibling answers, the decision model is probed alongside, both ok', async () => {
      const ep = await createEndpoint({
        ...VALID, apiKey: 'sk-cql',
        models: [{ id: 'kimi-k3', coding: true }, { id: 'agx-laya', decision: 'systemone_chat' }],
      });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }, { id: 'kimi-k3' }] } } as any);
      // The chat walk skips agx-laya (kind decision) and probes kimi-k3.
      mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 5, detail: 'decision OK' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(true);
      expect(result.completionAuth).toBe('ok');
      // The chat probe went to the chat sibling, NOT the decision route.
      expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({ model: 'kimi-k3' });
      // The declared decision model was probed with the decision shape.
      expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: VALID.baseUrl, apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
      expect(result.detail).toContain('decision OK');
      // No probedModel note: the first ELIGIBLE model answered.
      expect(result.probedModel).toBeUndefined();
    });

    it('a DECLARED decision model whose decision probe FAILS fails the Test honestly (the chat sibling answering does not mask it)', async () => {
      const ep = await createEndpoint({
        ...VALID, apiKey: 'sk-cql',
        models: [{ id: 'kimi-k3', coding: true }, { id: 'agx-laya', decision: 'systemone_chat' }],
      });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'kimi-k3' }, { id: 'agx-laya' }] } } as any);
      mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 5, error: 'HTTP 500 engine down' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(false);
      expect(result.completionAuth).toBe('ok');
      expect(result.error).toContain('typed-decision probe on "agx-laya" failed');
      expect(result.error).toContain('HTTP 500 engine down');
    });

    it('an ALL-decision endpoint (no chat sibling): the decision model IS the verdict — ok when it answers, and completionAuth is OMITTED (no chat probe ran; reviewer B1)', async () => {
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-cql', models: [{ id: 'agx-laya', decision: 'systemone_chat' }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 7, detail: 'decision OK' });
      const result = await testEndpointConnection(ep.id);
      // B1: no chat probe ran, so the field whose contract says "present only
      // when the chat probe ran" must be absent — never a false "auth verified".
      expect(result).toMatchObject({ ok: true, models: ['agx-laya'] });
      expect(result.completionAuth).toBeUndefined();
      expect(result.detail).toContain('decision OK');
      // No plain chat call was attempted (nothing to authenticate with).
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: VALID.baseUrl, apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    });

    it('an UNDECLARED all-decision list (heuristic-read ids, no row flags): the decision probe is the verdict; completionAuth omitted (no chat probe ran)', async () => {
      // A chat-synced row whose every id the registry reads as decision (the
      // raw-LiteLLM sync case: no flags at all).
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-cql', models: [{ id: 'agx-laya' }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }, { id: 'kev-alpha' }] } } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 9, detail: 'decision OK' });
      const result = await testEndpointConnection(ep.id);
      expect(result).toMatchObject({ ok: true });
      expect(result.completionAuth).toBeUndefined();
      expect(result.models).toEqual(['agx-laya', 'kev-alpha']);
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: VALID.baseUrl, apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    });

    it('REVIEWER B1 REGRESSION — a key that 401s the chat routes while the decision probe answers is a FAILED Test: the chat failures are never erased (the ticket\'s own bug class, inverted)', async () => {
      // The live-probed B1 scenario: row {kimi-k3 chat, agx-laya declared},
      // chat probe 401s (a per-route LiteLLM key), decision probe answers.
      // Pre-fix this returned ok:true + completionAuth:'ok' — "Connected ·
      // chat-completion auth verified" — with the 401 evidence erased.
      const ep = await createEndpoint({
        ...VALID, apiKey: 'sk-per-route',
        models: [{ id: 'kimi-k3', coding: true }, { id: 'agx-laya', decision: 'systemone_chat' }],
      });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'kimi-k3' }, { id: 'agx-laya' }] } } as any);
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 401, data: { error: { message: 'Invalid API key' } } },
        message: 'Request failed with status code 401',
      } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 8, detail: 'decision OK' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(false);
      expect(result.completionAuth).toBe('failed');
      // The 401 evidence survives.
      expect(result.error).toContain('401');
      expect(result.error).toContain('check the key');
      // The decision probe's success is reported as the partial alibi, not a pass.
      expect(result.error).toContain('typed-decision probe on "agx-laya" answered');
      expect(result.error).toContain('chat route(s) did not');
    });

    it('REVIEWER A3 — a declared decision id NOT in the /models list is a NOTE, never a probe target (a renamed route must not false-red the Test)', async () => {
      const ep = await createEndpoint({
        ...VALID, apiKey: 'sk-cql',
        models: [{ id: 'kimi-k3', coding: true }, { id: 'agx-laya-old', decision: 'systemone_chat' }],
      });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'kimi-k3' }, { id: 'agx-laya' }] } } as any);
      mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(true);
      expect(result.completionAuth).toBe('ok');
      // The renamed declared id is a note; the undeclared listed decision id
      // (agx-laya, heuristic) is NOT probed either (the row declared another).
      expect(result.detail).toContain('agx-laya-old');
      expect(result.detail).toContain('not in the server\'s /models list');
      expect(mockProbeSystemOne).not.toHaveBeenCalled();
    });

    it('a plain 400 (no usage guide) is NOT rescued — the honest failure stands (auth/billing/malformed never masked)', async () => {
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-cql', models: [{ id: 'agx-laya', decision: 'systemone_chat' }, { id: 'kimi-k3', coding: true }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'kimi-k3' }, { id: 'agx-laya' }] } } as any);
      // A plain 400 on the chat sibling: neither usage-guide rescue nor decision fallback applies.
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { error: { message: 'max_tokens must be an integer' } } },
        message: 'Request failed with status code 400',
      } as any);
      // The declared decision model's probe fails too.
      mockProbeSystemOne.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 3, error: 'HTTP 502 bad gateway' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('typed-decision probe on "agx-laya" failed');
    });

    it('the usage-guide 400 whose decision re-probe FAILS TOO reports both shapes honestly (never a silent pass)', async () => {
      // Row reads it as a chat model (coding:true sync flag) so the walk runs,
      // draws the usage guide, and the decision re-probe fails too.
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-cql', models: [{ id: 'agx-laya', coding: true }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: { message: 'agx-laya is a typed-decision model, not a chat model. Send "questions": {key: {"instructions": str, "type": "choice"|"noul"|"score", "criteria": [..]}} …' } },
        },
        message: 'Request failed with status code 400',
      } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 3, error: 'HTTP 502 bad gateway' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(false);
      expect(result.completionAuth).toBe('failed');
      expect(result.error).toContain('agx-laya');
      expect(result.error).toContain('HTTP 502');
      expect(result.error).toContain('typed-decision');
    });

    it('a keyless decision endpoint keeps the keyless shape: ok + models, no probe (the auth contract is unchanged)', async () => {
      const ep = await createEndpoint({ ...VALID, models: [{ id: 'agx-laya', decision: 'systemone_chat' }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
      const result = await testEndpointConnection(ep.id);
      expect(result).toEqual({ ok: true, models: ['agx-laya'] });
      expect(mockProbeSystemOne).not.toHaveBeenCalled();
    });

    it('key-safe: the rescued detail and every error surface never leak the key (replay of the leak class)', async () => {
      const ep = await createEndpoint({ ...VALID, apiKey: 'sk-do-not-leak', models: [{ id: 'agx-laya' }] });
      mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: { message: 'agx-laya is a typed-decision model, not a chat model (key sk-do-not-leak rejected). Send "questions": {"instructions", "type": "choice"|"noul"|"score", "criteria"} …' } },
        },
        message: 'Request failed with status code 400 (sk-do-not-leak)',
      } as any);
      mockProbeSystemOne.mockResolvedValueOnce({ ok: true, target: 't', latencyMs: 4, detail: 'decision OK' });
      const result = await testEndpointConnection(ep.id);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
    });
  });
});

describe('probeEndpointModels', () => {
  it('uses an explicitly passed apiKey over any stored key, and strips a trailing slash', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-stored' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'a' }] } } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
    const result = await probeEndpointModels({ baseUrl: 'http://other.host:1234/v1/', apiKey: 'sk-typed', endpointId: ep.id });
    expect(result).toEqual({ ok: true, models: ['a'], completionAuth: 'ok' });
    const [url, opts] = mockedAxios.get.mock.calls[0];
    expect(url).toBe('http://other.host:1234/v1/models');
    expect((opts as any).headers.Authorization).toBe('Bearer sk-typed');
    // The completion probe ran with the same explicit key (not the stored one).
    const [postUrl, , postOpts] = mockedAxios.post.mock.calls[0];
    expect(postUrl).toBe('http://other.host:1234/v1/chat/completions');
    expect((postOpts as any).headers.Authorization).toBe('Bearer sk-typed');
  });

  it('falls back to the stored key of endpointId when apiKey is omitted', async () => {
    const ep = await createEndpoint({ ...VALID, apiKey: 'sk-stored' });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'qwen3:32b' }] } } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [] } } as any);
    await probeEndpointModels({ baseUrl: VALID.baseUrl, endpointId: ep.id });
    const [, opts] = mockedAxios.get.mock.calls[0];
    expect((opts as any).headers.Authorization).toBe('Bearer sk-stored');
    const [, , postOpts] = mockedAxios.post.mock.calls[0];
    expect((postOpts as any).headers.Authorization).toBe('Bearer sk-stored');
  });

  it('sends no auth without an explicit key or endpointId — and skips the completion probe', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } } as any);
    await probeEndpointModels({ baseUrl: VALID.baseUrl });
    const [, opts] = mockedAxios.get.mock.calls[0];
    expect((opts as any).headers.Authorization).toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('404s an unknown endpointId and 400s a bad baseUrl — nothing is persisted', async () => {
    await expect(probeEndpointModels({ baseUrl: VALID.baseUrl, endpointId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(probeEndpointModels({ baseUrl: 'not-a-url' })).rejects.toMatchObject({ statusCode: 400 });
    expect(db).toHaveLength(0);
  });

  it('reduces failures to a key-safe message', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 403, statusText: 'Forbidden' },
      message: 'Request failed with status code 403',
    });
    const result = await probeEndpointModels({ baseUrl: VALID.baseUrl, apiKey: 'sk-do-not-leak' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
    expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
  });

  it('flags a bad draft key distinctly (models list OK, chat completion 401) without persisting anything', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'a' }] } } as any);
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, statusText: 'Unauthorized' },
      message: 'Request failed with status code 401 (invalid key sk-do-not-leak)',
    });
    const result = await probeEndpointModels({ baseUrl: VALID.baseUrl, apiKey: 'sk-do-not-leak' });
    expect(result.ok).toBe(false);
    expect(result.completionAuth).toBe('failed');
    expect(result.models).toEqual(['a']);
    expect(result.error).toContain('models list OK');
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toContain('check the key');
    expect(JSON.stringify(result)).not.toContain('sk-do-not-leak');
    expect(db).toHaveLength(0);
  });
});

describe('parseRegistrySpec', () => {
  it('splits on the FIRST colon (model ids may contain colons)', () => {
    expect(parseRegistrySpec('my-ollama:qwen3:32b')).toEqual({ label: 'my-ollama', modelId: 'qwen3:32b' });
  });
  it('rejects built-in ids and malformed specs', () => {
    expect(parseRegistrySpec('glm-5.2')).toBeNull();
    expect(parseRegistrySpec(':nolabel')).toBeNull();
    expect(parseRegistrySpec('noid:')).toBeNull();
    expect(parseRegistrySpec('Bad Label:x')).toBeNull();
  });
});

describe('resolveRegistryModel (run path)', () => {
  const seed = async () => {
    await createEndpoint({
      ...VALID,
      apiKey: 'sk-registry',
      models: [
        // 2026-09-08 flags: matryoshka (MRL embedding truncation) + thinking 'off'.
        { id: 'qwen3:32b', coding: true, vision: true, matryoshka: true, thinking: 'off' as const },
        { id: 'text-only' },
      ],
    });
  };

  it('resolves an enabled row to url + decrypted key + flags (incl. matryoshka / thinkingOff)', async () => {
    await seed();
    const reg = await resolveRegistryModel('my-ollama:qwen3:32b', 'u1');
    expect(reg).toEqual({
      url: 'http://192.168.1.50:11434/v1/chat/completions',
      baseUrl: 'http://192.168.1.50:11434/v1', // non-chat shapes (embeddings/rerank roles) build their own path
      apiKey: 'sk-registry',
      model: 'qwen3:32b',
      label: 'my-ollama',
      supportsVision: true,
      coding: true,
      matryoshka: true,
      thinkingOff: true,
      providerShape: 'openai_chat', // 2026-09-24: the decision gate picks its client by the endpoint's shape
      // 2026-09-27 seat/provider limits: what the model IS + its resolved limits.
      chatCapable: true,
      kind: 'chat',
      maxToolsSource: 'none',   // 'qwen3:32b' is no OpenAI-like id → no class default cap
      providerClass: 'other',
      reasoningEffort: 'auto',
    });
    // Unflagged entries resolve with both flags false — never undefined (consumers test `=== true`).
    // 2026-09-27: `coding` is a LEGACY ALIAS of chatCapable — a plain chat-looking
    // id ('text-only') reads TRUE now (the seat picks it; "coding is a seat
    // choice, not a model capability"); only a non-chat kind reads false.
    const plain = await resolveRegistryModel('my-ollama:text-only', 'u1');
    expect(plain).toMatchObject({ matryoshka: false, thinkingOff: false, coding: true, chatCapable: true, kind: 'chat', supportsVision: false });
  });

  it('returns null for built-in ids, unknown labels, unknown models, and disabled rows', async () => {
    await seed();
    (prisma.modelEndpoint.findFirst as jest.Mock).mockClear(); // ignore createEndpoint's uniqueness probe
    expect(await resolveRegistryModel('glm-5.2', 'u1')).toBeNull();
    expect(prisma.modelEndpoint.findFirst).not.toHaveBeenCalled(); // built-ins skip the DB
    expect(await resolveRegistryModel('other:qwen3:32b', 'u1')).toBeNull();
    expect(await resolveRegistryModel('my-ollama:nonexistent', 'u1')).toBeNull();

    const rows = await listEndpoints();
    await updateEndpoint(rows[0].id, { enabled: false });
    expect(await resolveRegistryModel('my-ollama:qwen3:32b', 'u1')).toBeNull();
  });

  // 2026-10-06 retired entries (f90 follow-up, PR #1312's durable follow-through): the gateway
  // route was torn down, so the entry stays LISTED for provenance but stops resolving — the
  // same shape a deleted model has. This is what retires api-cohere-command-a-plus.
  it('a retired (unservable) entry never resolves — the deleted-model path — and the flag survives a save', async () => {
    await seed();
    const rows = await listEndpoints();
    await updateEndpoint(rows[0].id, { models: [
      { id: 'qwen3:32b', coding: true, vision: true, matryoshka: true, thinking: 'off' as const },
      { id: 'api-cohere-command-a-plus', unservable: true },
    ] });
    // Retired: resolves to NULL (seats take their built-in fallback; verify 400s).
    expect(await resolveRegistryModel('my-ollama:api-cohere-command-a-plus', 'u1')).toBeNull();
    // Its neighbour still resolves — retirement is per-entry, never per-endpoint.
    expect(await resolveRegistryModel('my-ollama:qwen3:32b', 'u1')).toMatchObject({ model: 'qwen3:32b', chatCapable: true });
    // The flag survived the save's whitelist copy (validateModels)…
    const stored = (await listEndpoints())[0].models.find(m => m.id === 'api-cohere-command-a-plus');
    expect(stored?.unservable).toBe(true);
    // …and a re-save that OMITS the flag keeps the row but lets it resolve again ONLY when the
    // admin explicitly drops it — the whitelist never invents the flag on its own.
    await updateEndpoint(rows[0].id, { models: [
      { id: 'qwen3:32b', coding: true },
      { id: 'api-cohere-command-a-plus' },
    ] });
    expect((await listEndpoints())[0].models.find(m => m.id === 'api-cohere-command-a-plus')?.unservable).toBeUndefined();
    expect(await resolveRegistryModel('my-ollama:api-cohere-command-a-plus', 'u1')).toMatchObject({ model: 'api-cohere-command-a-plus' });
  });

  it('honors the model entry flags (vision default false; a plain chat id is chat-capable; an embeddings id is not)', async () => {    await seed();
    const reg = await resolveRegistryModel('my-ollama:text-only', 'u1');
    expect(reg).toMatchObject({ supportsVision: false, coding: true, chatCapable: true });
    // 2026-09-27: the kind heuristic keeps non-chat models OFF the chat seats
    // (an explicit `kind` or the legacy [coding] flag would override it).
    const rows = await listEndpoints();
    await updateEndpoint(rows[0].id, { models: [
      { id: 'qwen3:32b', coding: true },
      { id: 'Qwen/Qwen3-Embedding-8B' },
      { id: 'bge-reranker-v2-m3', kind: 'chat' as const },
      { id: 'api-openai-gpt-6-astra', maxTools: 64 },
    ] });
    expect(await resolveRegistryModel('my-ollama:Qwen/Qwen3-Embedding-8B', 'u1')).toMatchObject({ coding: false, chatCapable: false, kind: 'embeddings' });
    expect(await resolveRegistryModel('my-ollama:bge-reranker-v2-m3', 'u1')).toMatchObject({ coding: true, chatCapable: true, kind: 'chat' }); // explicit kind wins
    expect(await resolveRegistryModel('my-ollama:api-openai-gpt-6-astra', 'u1')).toMatchObject({ chatCapable: true, providerClass: 'openai', maxTools: 64, maxToolsSource: 'model' });
  });

  // 2026-10-06 chat-catalog leak: gateway-synced registry rows (agx-embed /
  // agx-rerank on cql-litellm) passed the chat gate on a stored kind/coding
  // flag that lied. The bounded id token now wins — see NON_CHAT_ID_OVERRIDES.
  it('a lying chat kind/coding flag on an embed/rerank id cannot make it chat-capable (the gateway leak)', async () => {
    await seed();
    const rows = await listEndpoints();
    await updateEndpoint(rows[0].id, { models: [
      { id: 'agx-embed', kind: 'chat' as const, coding: true },
      { id: 'agx-rerank', kind: 'chat' as const, coding: true },
      { id: 'Qwen/Qwen3-Embedding-8B', kind: 'chat' as const },
      { id: 'kimi-k3', kind: 'chat' as const },
      { id: 'spark-glm-5.3-flash', kind: 'chat' as const },
    ] });
    // The leaking pair: no kind/coding flag can rescue them into chat.
    expect(await resolveRegistryModel('my-ollama:agx-embed', 'u1')).toMatchObject({ coding: false, chatCapable: false, kind: 'embeddings' });
    expect(await resolveRegistryModel('my-ollama:agx-rerank', 'u1')).toMatchObject({ coding: false, chatCapable: false, kind: 'rerank' });
    // Controls: bounded tokens don't over-exclude real chat ids.
    expect(await resolveRegistryModel('my-ollama:kimi-k3', 'u1')).toMatchObject({ coding: true, chatCapable: true, kind: 'chat' });
    expect(await resolveRegistryModel('my-ollama:spark-glm-5.3-flash', 'u1')).toMatchObject({ coding: true, chatCapable: true, kind: 'chat' });
  });

  it('caches per spec+user for 30s (one DB read across repeated lookups)', async () => {
    await seed();
    (prisma.modelEndpoint.findFirst as jest.Mock).mockClear(); // ignore createEndpoint's uniqueness probe
    await resolveRegistryModel('my-ollama:qwen3:32b', 'u1');
    await resolveRegistryModel('my-ollama:qwen3:32b', 'u1');
    expect(prisma.modelEndpoint.findFirst).toHaveBeenCalledTimes(1);
    // Negative results are cached too.
    await resolveRegistryModel('my-ollama:nope', 'u1');
    await resolveRegistryModel('my-ollama:nope', 'u1');
    expect(prisma.modelEndpoint.findFirst).toHaveBeenCalledTimes(2);
    // Mutations invalidate immediately.
    const rows = await listEndpoints();
    await updateEndpoint(rows[0].id, { enabled: false });
    expect(await resolveRegistryModel('my-ollama:qwen3:32b', 'u1')).toBeNull();
  });

  it('instance-wide rows match any user; per-user rows match only their owner', async () => {
    await seed();
    db.push({
      id: 'e-user', ownerUserId: 'u-owner', label: 'personal', providerShape: 'openai_chat',
      baseUrl: 'http://10.0.0.9:1234/v1', apiKeyEnc: null,
      models: [{ id: 'm1', coding: true }], enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
    expect(await resolveRegistryModel('my-ollama:qwen3:32b', 'any-user')).not.toBeNull();
    expect(await resolveRegistryModel('personal:m1', 'u-owner')).not.toBeNull();
    expect(await resolveRegistryModel('personal:m1', 'someone-else')).toBeNull();
  });
});

// 2026-10-06 chat-catalog leak: the single gate behind
// model-catalog.ts listChatModelCatalog — gateway-synced rows (agx-embed /
// agx-rerank on cql-litellm) reached it with a kind/coding flag that lied.
describe('isChatCapableEntry (the chat-catalog gate)', () => {
  it('a lying chat kind/coding flag on an embed/rerank id cannot pass the gate (agx-embed / agx-rerank)', () => {
    // The exact leaking rows: stored kind 'chat' + coding true, still NOT chat.
    expect(isChatCapableEntry({ id: 'agx-embed', kind: 'chat', coding: true })).toBe(false);
    expect(isChatCapableEntry({ id: 'agx-rerank', kind: 'chat', coding: true })).toBe(false);
    // Other bounded embed/rerank shapes stay excluded even with the flag set.
    expect(isChatCapableEntry({ id: 'Qwen/Qwen3-Embedding-8B', kind: 'chat', coding: true })).toBe(false);
    expect(isChatCapableEntry({ id: 'text-embedding-3-small', kind: 'chat', coding: true })).toBe(false);
    // No kind stored at all (the synced default) — still excluded by the id.
    expect(isChatCapableEntry({ id: 'agx-embed' })).toBe(false);
    expect(isChatCapableEntry({ id: 'agx-rerank' })).toBe(false);
    // Controls: real chat ids with a chat kind stay chat-capable.
    expect(isChatCapableEntry({ id: 'kimi-k3', kind: 'chat', coding: true })).toBe(true);
    expect(isChatCapableEntry({ id: 'spark-glm-5.3-flash', kind: 'chat' })).toBe(true);
    expect(isChatCapableEntry({ id: 'api-openai-gpt-6-astra', coding: true })).toBe(true);
    // The pinned boundary: 'reranker' is NOT the 'rerank' token — an explicit
    // chat kind on it wins (model-roles / bge-reranker chat-override contract).
    expect(isChatCapableEntry({ id: 'bge-reranker-v2-m3', kind: 'chat' })).toBe(true);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://h:1/v1///')).toBe('http://h:1/v1');
  });
});

// ── Nebius B300 registration (2026-09-15 — the utility_fallback node) ────────
// The fallback + parse-verifier work seats a self-hosted GPU node (Nebius
// B300) as the admin-selectable middle utility leg. These tests prove the
// registry half: the endpoint registers, resolves (a '/' in the model id
// survives the first-colon spec split), and passes the connectivity check.
describe('Nebius B300 registration (2026-09-15)', () => {
  const NEBIUS = {
    label: 'nebius-b300',
    providerShape: 'openai_chat',
    baseUrl: 'https://api.studio.nebius.com/v1',
    apiKey: 'sk-nebius',
    // The no-think flag is `thinking: 'off'` on the INPUT entry (whitelist-
    // validated; a raw `thinkingOff` field would be silently dropped) — it
    // resolves to thinkingOff: true on the run path.
    models: [{ id: 'Qwen/Qwen3-32B', displayName: 'Qwen3 32B', coding: true, thinking: 'off' as const }],
    enabled: true,
  };

  it("registers and resolves 'nebius-b300:Qwen/Qwen3-32B' — url, model id with its slash intact, coding + thinkingOff flags", async () => {
    const ep = await createEndpoint(NEBIUS);
    expect(ep).toMatchObject({ label: 'nebius-b300', baseUrl: 'https://api.studio.nebius.com/v1', hasApiKey: true, enabled: true });
    expect(JSON.stringify(ep)).not.toContain('sk-nebius');

    const reg = await resolveRegistryModel('nebius-b300:Qwen/Qwen3-32B');
    expect(reg).toEqual({
      url: 'https://api.studio.nebius.com/v1/chat/completions',
      baseUrl: 'https://api.studio.nebius.com/v1',
      apiKey: 'sk-nebius',
      model: 'Qwen/Qwen3-32B', // the '/' in the model id survives the FIRST-colon split
      label: 'nebius-b300',
      supportsVision: false,
      coding: true,
      matryoshka: false,
      thinkingOff: true,
      providerShape: 'openai_chat',
      chatCapable: true, kind: 'chat', maxToolsSource: 'none', providerClass: 'other', reasoningEffort: 'auto', // 2026-09-27 limits
    });
  });

  it('testEndpointConnection against the Nebius shape: GET /models then the completion-auth probe → ok', async () => {
    const ep = await createEndpoint(NEBIUS);
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'Qwen/Qwen3-32B' }, { id: 'Qwen/Qwen3-Embedding-8B' }] } } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'x' } }] } } as any);
    const result = await testEndpointConnection(ep.id);
    expect(result).toEqual({ ok: true, models: ['Qwen/Qwen3-32B', 'Qwen/Qwen3-Embedding-8B'], completionAuth: 'ok' });
    const [getUrl, getOpts] = mockedAxios.get.mock.calls[0];
    expect(getUrl).toBe('https://api.studio.nebius.com/v1/models');
    expect((getOpts as any).headers.Authorization).toBe('Bearer sk-nebius');
    const [postUrl, postBody, postOpts] = mockedAxios.post.mock.calls[0];
    expect(postUrl).toBe('https://api.studio.nebius.com/v1/chat/completions');
    expect(postBody).toMatchObject({ model: 'Qwen/Qwen3-32B', max_tokens: 1, stream: false });
    expect((postOpts as any).headers.Authorization).toBe('Bearer sk-nebius');
    expect(JSON.stringify(result)).not.toContain('sk-nebius');
  });

  it('self-hosted vLLM variant: a trailing-slash baseUrl stores and resolves byte-identically to the clean one', async () => {
    const slash = await createEndpoint({
      label: 'vllm-slash', providerShape: 'openai_chat', baseUrl: 'http://10.0.0.8:8000/v1/',
      models: [{ id: 'Qwen/Qwen3-32B', coding: true }], enabled: true,
    });
    const plain = await createEndpoint({
      label: 'vllm-plain', providerShape: 'openai_chat', baseUrl: 'http://10.0.0.8:8000/v1',
      models: [{ id: 'Qwen/Qwen3-32B', coding: true }], enabled: true,
    });
    expect(slash.baseUrl).toBe('http://10.0.0.8:8000/v1');
    expect(slash.baseUrl).toBe(plain.baseUrl);
    const regSlash = await resolveRegistryModel('vllm-slash:Qwen/Qwen3-32B');
    const regPlain = await resolveRegistryModel('vllm-plain:Qwen/Qwen3-32B');
    expect(regSlash).toMatchObject({
      url: 'http://10.0.0.8:8000/v1/chat/completions',
      baseUrl: 'http://10.0.0.8:8000/v1',
      model: 'Qwen/Qwen3-32B',
      coding: true,
    });
    // Identical resolution, keyless self-hosted node (apiKey undefined).
    expect({ ...regSlash, label: 'x' }).toEqual({ ...regPlain, label: 'x' });
    expect(regSlash!.apiKey).toBeUndefined();
  });
});


/* 2026-09-26 (open-weight decision backends): the two decision-backend flags on
 * a registry model — `calibrated` (the admin asserts calibrated probabilities)
 * and `maxStateChars` (the per-backend state cap) — round-trip through
 * create / update → summary → resolveRegistryModel; unflagged models resolve
 * byte-identically (no keys at all, the convention `image` set). */
describe('decision-backend flags: calibrated + maxStateChars (2026-09-26)', () => {
  it('round-trip through create → summary → resolveRegistryModel; unflagged entries carry neither key; garbage values are dropped on save', async () => {
    const created = await createEndpoint({
      label: 'laya',
      providerShape: 'systemone',
      baseUrl: 'http://10.0.0.7:8000/v1',
      models: [
        { id: 'typed-decisions', calibrated: true, maxStateChars: 1200 },
        { id: 'multilingual', maxStateChars: 3000.9 },      // floored
        { id: 'english', calibrated: false, maxStateChars: 0 }, // both dropped
        { id: 'weird', maxStateChars: -5 as any },           // dropped
      ],
    });
    expect(created.models).toEqual([
      { id: 'typed-decisions', calibrated: true, maxStateChars: 1200 },
      { id: 'multilingual', maxStateChars: 3000 },
      { id: 'english' },
      { id: 'weird' },
    ]);
    const typed = await resolveRegistryModel('laya:typed-decisions');
    expect(typed).toMatchObject({ providerShape: 'systemone', model: 'typed-decisions', calibrated: true, maxStateChars: 1200 });
    const multi = await resolveRegistryModel('laya:multilingual');
    expect(multi).toMatchObject({ maxStateChars: 3000 });
    expect('calibrated' in multi!).toBe(false);
    const english = await resolveRegistryModel('laya:english');
    expect('calibrated' in english!).toBe(false);
    expect('maxStateChars' in english!).toBe(false);
    // The pre-change resolution shape for an unflagged model is unchanged apart from the
    // 2026-09-27 limit fields; a DECISION-shape endpoint's models are never chat-capable.
    expect(english).toEqual({
      url: 'http://10.0.0.7:8000/v1/chat/completions', baseUrl: 'http://10.0.0.7:8000/v1', apiKey: undefined, model: 'english', label: 'laya',
      supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'systemone',
      chatCapable: false, kind: 'decision', maxToolsSource: 'none', providerClass: 'other', reasoningEffort: 'auto',
    });
    // An update that re-sends the models keeps the flags; dropping them clears them.
    const updated = await updateEndpoint(created.id, { models: [{ id: 'typed-decisions', calibrated: true, maxStateChars: 1500 }, { id: 'multilingual' }] });
    expect(updated.models).toEqual([{ id: 'typed-decisions', calibrated: true, maxStateChars: 1500 }, { id: 'multilingual' }]);
    expect(await resolveRegistryModel('laya:typed-decisions')).toMatchObject({ maxStateChars: 1500, calibrated: true });
    expect('maxStateChars' in (await resolveRegistryModel('laya:multilingual'))!).toBe(false);
  });
});

/* Laya follow-up (2026-09-26): the per-model `decision: 'systemone_chat'` flag (a typed-decision model behind an
 * OpenAI-compatible proxy — prod's cql-litellm:agx-laya) round-trips like the other decision fields; the dedicated
 * `systemone_chat` endpoint shape is accepted and its connectivity check probes through the chat route. */
describe('decision-backend flag: decision "systemone_chat" + the systemone_chat shape (Laya follow-up, 2026-09-26)', () => {
  beforeEach(() => { mockProbeSystemOne.mockClear(); });

  it('round-trips through create → summary → resolveRegistryModel on an openai_chat endpoint; an unflagged model carries no key; garbage is dropped; the run-path resolution of the flagged model is otherwise unchanged', async () => {
    const created = await createEndpoint({
      label: 'cql-litellm',
      providerShape: 'openai_chat',
      baseUrl: 'https://llm.cql.ca/v1',
      apiKey: 'sk-cql',
      models: [
        { id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 },
        { id: 'agx-chat', coding: true },
        { id: 'weird', decision: 'foo' as any },
      ],
    });
    expect(created.models).toEqual([{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }, { id: 'agx-chat', coding: true }, { id: 'weird' }]);
    const laya = await resolveRegistryModel('cql-litellm:agx-laya');
    expect(laya).toMatchObject({ providerShape: 'openai_chat', decision: 'systemone_chat', maxStateChars: 3800, model: 'agx-laya', baseUrl: 'https://llm.cql.ca/v1', url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'sk-cql' });
    const chat = await resolveRegistryModel('cql-litellm:agx-chat');
    expect('decision' in chat!).toBe(false);
    expect(chat).toMatchObject({ providerShape: 'openai_chat', coding: true });
    // An update that drops the flag clears it.
    const updated = await updateEndpoint(created.id, { models: [{ id: 'agx-laya', maxStateChars: 3800 }] });
    expect(updated.models).toEqual([{ id: 'agx-laya', maxStateChars: 3800 }]);
    expect('decision' in (await resolveRegistryModel('cql-litellm:agx-laya'))!).toBe(false);
  });

  it('the dedicated systemone_chat shape is accepted; its connectivity check REQUIRES GET /models (no 404 tolerance) and probes the FIRST ROW MODEL through the chat transport, noting a model the proxy does not list', async () => {
    const ep = await createEndpoint({ label: 'laya-proxy', providerShape: 'systemone_chat', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', models: [{ id: 'agx-laya', maxStateChars: 3800 }] });
    expect(ep.providerShape).toBe('systemone_chat');
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-chat' }, { id: 'agx-laya' }] } } as any);
    const ok = await testEndpointConnection(ep.id);
    expect(ok).toEqual({ ok: true, models: ['agx-chat', 'agx-laya'], completionAuth: 'ok', detail: 'probe ok' });
    expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'agx-laya', transport: 'chat' });
    // GET /models 404 → the check fails (a systemone endpoint tolerates it, the chat proxy serves /models).
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 }, message: 'nope' });
    const nf = await testEndpointConnection(ep.id);
    expect(nf.ok).toBe(false);
    expect(mockProbeSystemOne).toHaveBeenCalledTimes(1);
    // A row model the proxy does not list: the probe still decides; the detail says so.
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-chat' }] } } as any);
    const unlisted = await testEndpointConnection(ep.id);
    expect(unlisted.ok).toBe(true);
    expect(unlisted.detail).toContain('"agx-laya" is not in the proxy\'s /models list');
    // A failed probe → completionAuth failed with the probe's error.
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [{ id: 'agx-laya' }] } } as any);
    mockProbeSystemOne.mockResolvedValueOnce({ ok: false, target: 't', latencyMs: 2, error: 'HTTP 400 typed-decision model' });
    const failed = await testEndpointConnection(ep.id);
    expect(failed).toMatchObject({ ok: false, completionAuth: 'failed', error: expect.stringContaining('HTTP 400 typed-decision model') });
  });

  it('a systemone endpoint still tolerates a 404 on /models when it lists models itself, and probes over the systemone transport', async () => {
    const ep = await createEndpoint({ label: 'laya', providerShape: 'systemone', baseUrl: 'http://laya:8000/v1', models: [{ id: 'typed-decisions' }] });
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 }, message: 'nope' });
    const r = await testEndpointConnection(ep.id);
    expect(r).toEqual({ ok: true, models: ['typed-decisions'], completionAuth: 'ok', detail: 'probe ok' });
    expect(mockProbeSystemOne).toHaveBeenCalledWith({ baseUrl: 'http://laya:8000/v1', apiKey: undefined, model: 'typed-decisions' });
  });

  it('an unknown providerShape is still a clear 400 naming the three shapes', async () => {
    await expect(createEndpoint({ label: 'x', providerShape: 'anthropic', baseUrl: 'http://h/v1', models: [{ id: 'm' }] })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('"systemone_chat"') });
  });
});

// ── Seat governance — provider class on the summary + the registry resolution (audit E3, 2026-09-27) ──
describe('provider class (audit E3): endpoint summaries + registry resolutions carry the frontier signal', () => {
  it('an open host with open ids: providerClass open, no frontier ids, and the resolution is byte-identical to before (no governanceClass key; providerClass is the vendor class the tool caps read)', async () => {
    const ep = await createEndpoint({ ...VALID, models: [{ id: 'qwen3:32b', coding: true }, { id: 'openai/gpt-oss-120b', coding: true }] });
    expect(ep).toMatchObject({ providerClass: 'open', frontierModelIds: [] });
    const reg = await resolveRegistryModel('my-ollama:qwen3:32b');
    expect(reg).not.toBeNull();
    expect('governanceClass' in (reg as any)).toBe(false);
    const oss = await resolveRegistryModel('my-ollama:openai/gpt-oss-120b');
    expect('governanceClass' in (oss as any)).toBe(false);
  });

  it('a proxy that lists a frontier model id next to open ids: endpoint class stays open, the frontier id is named, and ONLY its resolution carries providerClass frontier (the E3 evidence shape)', async () => {
    const ep = await createEndpoint({
      label: 'cql-litellm', providerShape: 'openai_chat', baseUrl: 'https://llm.cql.ca/v1',
      models: [{ id: 'agx-chat', coding: true }, { id: 'api-anthropic-claude-fable-5-1', coding: true }, { id: 'agx-laya', decision: 'systemone_chat' }],
    });
    expect(ep).toMatchObject({ providerClass: 'open', frontierModelIds: ['api-anthropic-claude-fable-5-1'] });
    expect(await resolveRegistryModel('cql-litellm:api-anthropic-claude-fable-5-1')).toMatchObject({ governanceClass: 'frontier', coding: true });
    expect('governanceClass' in (await resolveRegistryModel('cql-litellm:agx-chat') as any)).toBe(false);
    expect('governanceClass' in (await resolveRegistryModel('cql-litellm:agx-laya') as any)).toBe(false);
    const listed = (await listEndpoints()).find(r => r.label === 'cql-litellm')!;
    expect(listed.frontierModelIds).toEqual(['api-anthropic-claude-fable-5-1']);
  });

  it('a frontier vendor HOST classes every listed model frontier, whatever its id', async () => {
    const ep = await createEndpoint({ label: 'oai', providerShape: 'openai_chat', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5.6-sol', coding: true }, { id: 'custom-alias', coding: true }] });
    expect(ep).toMatchObject({ providerClass: 'frontier', frontierModelIds: ['gpt-5.6-sol', 'custom-alias'] });
    expect(await resolveRegistryModel('oai:custom-alias')).toMatchObject({ governanceClass: 'frontier' });
  });

  it('the class is derived on read, never stored — an updated host or model list re-derives it', async () => {
    const ep = await createEndpoint({ ...VALID });
    expect(ep.providerClass).toBe('open');
    const moved = await updateEndpoint(ep.id, { baseUrl: 'https://api.anthropic.com/v1' });
    expect(moved).toMatchObject({ providerClass: 'frontier', frontierModelIds: ['qwen3:32b'] });
    const row = db.find(r => r.id === ep.id);
    expect(row.providerClass).toBeUndefined();
    expect(row.frontierModelIds).toBeUndefined();
  });
});

// ── refreshEndpointModels — model-list sync against the live /v1/models (ticket 780cd7a4) ──

describe('refreshEndpointModels (model-list sync, ticket 780cd7a4)', () => {
  // The llm-cql specimen (fleet-verified 2026-10-23): a stale snapshot naming
  // routes the gateway retired, next to flags an admin/detect set by hand.
  const llmCql = {
    label: 'llm-cql', providerShape: 'openai_chat', baseUrl: 'https://llm.cql.ca/v1',
    models: [
      { id: 'spark-deepseek-v4.1-flash-1017', coding: true },
      { id: 'spark-memo-v26-flash-rl', coding: true },
      { id: 'kimi-k3', coding: true, maxTools: 128 },
      { id: 'hand-retired-route', coding: true, unservable: true },
    ],
  };
  const liveList = (ids: string[]) => mockedAxios.get.mockResolvedValueOnce({ data: { data: ids.map(id => ({ id })) } } as any);

  it('adds NEW server ids as bare entries, RETIRES vanished row ids (unservable), and preserves every other flag', async () => {
    const ep = await createEndpoint({ ...llmCql });
    // The gateway stopped serving both spark routes and wen aliases; kimi-k3 stays; a NEW route appeared.
    liveList(['kimi-k3', 'api-openai-gpt-6-astra']);
    const out = await refreshEndpointModels(ep.id);
    expect(out.sync).toMatchObject({
      added: ['api-openai-gpt-6-astra'],
      retired: ['spark-deepseek-v4.1-flash-1017', 'spark-memo-v26-flash-rl'],
      backButKeptRetired: [],
      unchanged: ['kimi-k3'],
    });
    // The persisted row: vanished ids present-but-retired, the new id present, kimi-k3's maxTools kept.
    const byId = new Map(out.models.map(m => [m.id, m]));
    expect(byId.get('spark-deepseek-v4.1-flash-1017')).toMatchObject({ unservable: true, coding: true });
    expect(byId.get('spark-memo-v26-flash-rl')).toMatchObject({ unservable: true });
    expect(byId.get('api-openai-gpt-6-astra')).toEqual({ id: 'api-openai-gpt-6-astra' });
    expect(byId.get('kimi-k3')!.unservable).toBeUndefined();
    expect(byId.get('kimi-k3')).toMatchObject({ coding: true, maxTools: 128 });
    // Nothing is deleted — the row grew, it never shrank.
    expect(out.models.map(m => m.id).sort()).toEqual([
      'api-openai-gpt-6-astra', 'hand-retired-route', 'kimi-k3',
      'spark-deepseek-v4.1-flash-1017', 'spark-memo-v26-flash-rl',
    ].sort());
    // A retired spec stops resolving (the run-path leaf, same as a hand-retired entry).
    clearRegistryModelCache();
    expect(await resolveRegistryModel('llm-cql:spark-deepseek-v4.1-flash-1017')).toBeNull();
    expect(await resolveRegistryModel('llm-cql:api-openai-gpt-6-astra')).toMatchObject({ model: 'api-openai-gpt-6-astra' });
    expect(await resolveRegistryModel('llm-cql:kimi-k3')).toMatchObject({ maxTools: 128 });
    // The stored key never leaks into the sync result.
    expect(JSON.stringify(out)).not.toContain('apiKeyEnc');
  });

  it('a hand-retired entry the server still lists stays retired (backButKeptRetired) — un-retiring is a human decision', async () => {
    const ep = await createEndpoint({ ...llmCql });
    liveList(['kimi-k3', 'spark-deepseek-v4.1-flash-1017', 'spark-memo-v26-flash-rl', 'hand-retired-route']);
    const out = await refreshEndpointModels(ep.id);
    expect(out.sync).toMatchObject({
      added: [],
      retired: [],
      // The hand-retired entry is BACK on the server but stays retired; the two
      // spark routes are served again for the first time — they were never
      // retired, so they are simply unchanged.
      backButKeptRetired: ['hand-retired-route'],
      unchanged: expect.arrayContaining(['kimi-k3', 'spark-deepseek-v4.1-flash-1017', 'spark-memo-v26-flash-rl']),
    });
    const byId = new Map(out.models.map(m => [m.id, m]));
    expect(byId.get('hand-retired-route')?.unservable).toBe(true);
    expect(byId.get('spark-deepseek-v4.1-flash-1017')?.unservable).toBeUndefined();
  });

  it('an in-sync list writes nothing and still reports; a failed /v1/models fetch 502s with key-safe text and leaves the row untouched', async () => {
    const ep = await createEndpoint({ ...llmCql, models: [{ id: 'kimi-k3', coding: true }] });
    const rowBefore = JSON.stringify(db.find(r => r.id === ep.id)!.models);
    liveList(['kimi-k3']);
    const inSync = await refreshEndpointModels(ep.id);
    expect(inSync.sync).toEqual({ added: [], retired: [], backButKeptRetired: [], unchanged: ['kimi-k3'] });
    expect(JSON.stringify(db.find(r => r.id === ep.id)!.models)).toBe(rowBefore);
    expect(prisma.modelEndpoint.update).not.toHaveBeenCalled();
    // Fetch failure: safe text, no write.
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 401, statusText: 'Unauthorized' } } as any);
    await expect(refreshEndpointModels(ep.id)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('HTTP 401') });
    expect(JSON.stringify(db.find(r => r.id === ep.id)!.models)).toBe(rowBefore);
  });

  it('a DARK server (zero models listed while the row has some) is refused — the whole row is never retired by one bad /models answer', async () => {
    const ep = await createEndpoint({ ...llmCql });
    const rowBefore = JSON.stringify(db.find(r => r.id === ep.id)!.models);
    liveList([]);
    await expect(refreshEndpointModels(ep.id)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('ZERO models') });
    expect(JSON.stringify(db.find(r => r.id === ep.id)!.models)).toBe(rowBefore);
  });

  it('a misbehaving /v1/models that lists an id TWICE (or whitespace-padded) syncs once, never 400s — review F1', async () => {
    const ep = await createEndpoint({ ...llmCql, models: [{ id: 'kimi-k3', coding: true }] });
    // dup-route specimen shape (ticket f380838a's pinned server behaviour) + padding.
    liveList(['kimi-k3', 'gpt-4o', 'gpt-4o', '  glm-5.3  ']);
    const out = await refreshEndpointModels(ep.id);
    expect(out.sync.added).toEqual(['gpt-4o', 'glm-5.3']);
    expect(out.models.filter(m => m.id === 'gpt-4o')).toHaveLength(1);
    expect(out.models.find(m => m.id === 'glm-5.3')).toEqual({ id: 'glm-5.3' });
  });

  it('a whitespace-PADDED listing of an existing served id never retires it (the padded id matches after normalization) — review F1-R edge (a)', async () => {
    const ep = await createEndpoint({ ...llmCql, models: [{ id: 'glm-5.3', coding: true }, { id: 'kimi-k3', coding: true }] });
    // The server pads its listing of the served glm-5.3; kimi-k3 comes clean.
    // Pre-F1-R the raw listedSet held '  glm-5.3  ' → the served entry was
    // wrongly RETIRED and the row written. Normalized first, it matches.
    liveList(['kimi-k3', '  glm-5.3  ']);
    const out = await refreshEndpointModels(ep.id);
    expect(out.sync).toEqual({ added: [], retired: [], backButKeptRetired: [], unchanged: expect.arrayContaining(['glm-5.3', 'kimi-k3']) });
    const byId = new Map(out.models.map(m => [m.id, m]));
    expect(byId.get('glm-5.3')?.unservable).toBeUndefined();
    expect(byId.get('glm-5.3')).toMatchObject({ coding: true });
    // The padded id must not ALSO land as a separate padded entry.
    expect(out.models.some(m => m.id !== 'glm-5.3' && m.id.trim() === 'glm-5.3')).toBe(false);
    // The served spec still resolves on the run path.
    clearRegistryModelCache();
    expect(await resolveRegistryModel('llm-cql:glm-5.3')).toMatchObject({ model: 'glm-5.3' });
  });

  it('a whitespace-ONLY id is the zero-model refusal (the dark-server guard holds after trim) — review F1-R edge (b)', async () => {
    const ep = await createEndpoint({ ...llmCql });
    const rowBefore = JSON.stringify(db.find(r => r.id === ep.id)!.models);
    // Pre-F1-R this passed the raw !listed.length guard (length 1, non-empty
    // string) and retired the WHOLE row; pre-569d2486d it was an accidental
    // 400 refusal. Normalized first, it IS a zero-model answer → 502, row
    // untouched.
    liveList(['   ']);
    await expect(refreshEndpointModels(ep.id)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('ZERO models') });
    expect(JSON.stringify(db.find(r => r.id === ep.id)!.models)).toBe(rowBefore);
    expect(prisma.modelEndpoint.update).not.toHaveBeenCalled();
  });

  it('404 for an unknown endpoint; the kill switch refuses; the sync runs for a decision-shape endpoint too', async () => {    await expect(refreshEndpointModels('nope')).rejects.toMatchObject({ statusCode: 404 });
    const prev = process.env.MODEL_ENDPOINT_SYNC_DISABLED;
    process.env.MODEL_ENDPOINT_SYNC_DISABLED = '1';
    try {
      const ep = await createEndpoint({ ...llmCql });
      await expect(refreshEndpointModels(ep.id)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('MODEL_ENDPOINT_SYNC_DISABLED') });
      // The refusal happens BEFORE the fetch — the queued mock stays unconsumed
      // and must not leak into the decision-shape sync below.
      mockedAxios.get.mockReset();
      mockedAxios.get.mockResolvedValue({ data: { data: [] } } as any);
    } finally {
      if (prev === undefined) delete process.env.MODEL_ENDPOINT_SYNC_DISABLED; else process.env.MODEL_ENDPOINT_SYNC_DISABLED = prev;
    }
    // systemone_chat rows sync the same way (LiteLLM fronting Laya serves /v1/models).
    const decision = await createEndpoint({ label: 'cql-litellm', providerShape: 'systemone_chat', baseUrl: 'https://llm.cql.ca/v1', models: [{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }] });
    mockedAxios.get.mockReset();
    liveList(['agx-laya', 'agx-chat']);
    const out = await refreshEndpointModels(decision.id);
    expect(out.sync).toMatchObject({ added: ['agx-chat'], unchanged: ['agx-laya'] });
    const laya = out.models.find(m => m.id === 'agx-laya')!;
    expect(laya).toMatchObject({ decision: 'systemone_chat', maxStateChars: 3800 });
  });
});

/* 04c8ffd1 (2026-10-23): the per-model image-generation timeout
 * (EndpointModelEntry.imageTimeoutMs) — a slow local backend (Qwen-Image
 * behind LiteLLM, 5-10 min/generation) hard-died at the 120 s custom-leg cap.
 * Clamped [IMAGE_MODEL_TIMEOUT_MIN_MS, IMAGE_MODEL_TIMEOUT_MAX_MS] on save
 * (house style: normalize, never reject the whole save) and copied
 * present-only into the registry resolution. */
describe('per-model image timeout: imageTimeoutMs (04c8ffd1, 2026-10-23)', () => {
  it('validateModels copies an in-range value, floors a fraction, raises a sub-floor value to the clamp MIN and clamps an over-MAX value down; absent stays absent; garbage is dropped', async () => {
    const created = await createEndpoint({
      label: 'my-comfy',
      providerShape: 'openai_chat',
      baseUrl: 'http://10.0.0.5:8188/v1',
      apiKey: 'sk-registry',
      models: [
        { id: 'sdxl', image: true, imageTimeoutMs: 480_000 },          // in range — copied
        { id: 'sdxl-fraction', image: true, imageTimeoutMs: 299_999.9 }, // floored (house maxStateChars idiom)
        { id: 'sub-floor', image: true, imageTimeoutMs: 1_000 },       // raised to the MIN clamp
        { id: 'over-max', image: true, imageTimeoutMs: 9_000_000 },    // clamped to the MAX
        { id: 'garbage', image: true, imageTimeoutMs: 'abc' as any },  // dropped (never rejects the save)
        { id: 'absent', image: true },                                  // stays absent
        { id: 'non-image-with-value', imageTimeoutMs: 480_000 },       // meaningless on non-image models — still copied (the flag is advisory, never a gate)
      ],
    });
    expect(created.models).toEqual([
      { id: 'sdxl', image: true, imageTimeoutMs: 480_000 },
      { id: 'sdxl-fraction', image: true, imageTimeoutMs: 299_999 },
      { id: 'sub-floor', image: true, imageTimeoutMs: 30_000 },
      { id: 'over-max', image: true, imageTimeoutMs: 720_000 },
      { id: 'garbage', image: true },
      { id: 'absent', image: true },
      { id: 'non-image-with-value', imageTimeoutMs: 480_000 },
    ]);
    // The clamp constants are the exported pair (mirrors the [30 s, 12 min] doc).
    expect(IMAGE_MODEL_TIMEOUT_MIN_MS).toBe(30_000);
    expect(IMAGE_MODEL_TIMEOUT_MAX_MS).toBe(720_000);
    expect(IMAGE_MODEL_TIMEOUT_MAX_MS).toBeLessThan(900_000); // strictly under the agent tool's 15-min hard race
    // An update that drops the field clears it (present-only, like every other whitelist copy).
    const updated = await updateEndpoint(created.id, { models: [{ id: 'sdxl', image: true }] });
    expect(updated.models).toEqual([{ id: 'sdxl', image: true }]);
  });

  it('resolveRegistryModel carries the entry imageTimeoutMs present-only: an [image] entry with a value resolves with it; without → the key is absent', async () => {
    const created = await createEndpoint({
      label: 'my-comfy',
      providerShape: 'openai_chat',
      baseUrl: 'http://10.0.0.5:8188/v1',
      apiKey: 'sk-registry',
      models: [
        { id: 'sdxl', image: true, imageTimeoutMs: 480_000 },
        { id: 'plain', image: true },
        { id: 'chat-model' },
      ],
    });
    expect(created.label).toBe('my-comfy');
    const withTimeout = await resolveRegistryModel('my-comfy:sdxl', 'u1');
    expect(withTimeout).toMatchObject({ model: 'sdxl', image: true, imageTimeoutMs: 480_000 });
    // Present-only: a value-less entry resolves WITHOUT the key, and the whole
    // resolution shape for it is otherwise byte-identical (the `image` convention).
    const plain = await resolveRegistryModel('my-comfy:plain', 'u1');
    expect(plain).toMatchObject({ model: 'plain', image: true });
    expect('imageTimeoutMs' in plain!).toBe(false);
    const chat = await resolveRegistryModel('my-comfy:chat-model', 'u1');
    expect('imageTimeoutMs' in chat!).toBe(false);
    expect(chat!.image).toBeUndefined();
  });
});

/** 2026-10-25 (todo 87b020c4, owner ruling oq_7af5537b): the per-model
 * images-route base-URL override — the seat-side tailnet-direct flip for the
 * long-running image class (llm-cql → http://100.64.0.1:4001 while chat
 * keeps the Cloudflare baseUrl). Normalized on save (trim, trailing-slash
 * strip, http(s) URL-parse — garbage DROPPED, house style: the save never
 * rejects) and copied present-only into the registry resolution; consumers
 * without the field keep the byte-identical resolution shape. */
describe('per-model images-route base-URL override: imagesUrl (87b020c4, 2026-10-25)', () => {
  it('validateModels copies a valid http(s) URL trimmed + trailing-slash-stripped; drops non-URLs, non-http(s) schemes, empty and non-string values; absent stays absent; an update dropping the field clears it', async () => {
    const created = await createEndpoint({
      label: 'my-comfy',
      providerShape: 'openai_chat',
      baseUrl: 'http://10.0.0.5:8188/v1',
      apiKey: 'sk-registry',
      models: [
        { id: 'tailnet', image: true, imagesUrl: 'http://100.64.0.1:4001/v1/' }, // trailing slash stripped
        { id: 'full-route', image: true, imagesUrl: 'http://100.64.0.1:4001/v1/images/generations' }, // pasted route URL folds to its base
        { id: 'padded', image: true, imagesUrl: '  https://images.example.com ' },  // trimmed
        { id: 'not-a-url', image: true, imagesUrl: 'not a url' },                   // dropped — never rejects the save
        { id: 'wrong-scheme', image: true, imagesUrl: 'ftp://x.example.com' },      // dropped — http(s) only
        { id: 'empty', image: true, imagesUrl: '' },                                // dropped — absent semantics
        { id: 'non-string', image: true, imagesUrl: 42 as any },                    // dropped
        { id: 'absent', image: true },
      ],
    });
    expect(created.models).toEqual([
      { id: 'tailnet', image: true, imagesUrl: 'http://100.64.0.1:4001/v1' },
      { id: 'full-route', image: true, imagesUrl: 'http://100.64.0.1:4001/v1' },
      { id: 'padded', image: true, imagesUrl: 'https://images.example.com' },
      { id: 'not-a-url', image: true },
      { id: 'wrong-scheme', image: true },
      { id: 'empty', image: true },
      { id: 'non-string', image: true },
      { id: 'absent', image: true },
    ]);
    // Present-only: an update that drops the field CLEARS it (the CF-fallback revert lever).
    const updated = await updateEndpoint(created.id, { models: [{ id: 'tailnet', image: true }] });
    expect(updated.models).toEqual([{ id: 'tailnet', image: true }]);
  });

  it('resolveRegistryModel carries imagesUrl present-only — baseUrl intact (chat traffic untouched), a value-less entry resolves WITHOUT the key', async () => {
    await createEndpoint({
      label: 'my-comfy',
      providerShape: 'openai_chat',
      baseUrl: 'http://10.0.0.5:8188/v1',
      apiKey: 'sk-registry',
      models: [
        { id: 'tailnet', image: true, imagesUrl: 'http://100.64.0.1:4001/v1' },
        { id: 'plain', image: true },
        { id: 'chat-model' },
      ],
    });
    const withUrl = await resolveRegistryModel('my-comfy:tailnet', 'u1');
    expect(withUrl).toMatchObject({
      model: 'tailnet', image: true,
      baseUrl: 'http://10.0.0.5:8188/v1',            // chat surface unchanged
      imagesUrl: 'http://100.64.0.1:4001/v1',
    });
    const plain = await resolveRegistryModel('my-comfy:plain', 'u1');
    expect(plain).toMatchObject({ model: 'plain', image: true, baseUrl: 'http://10.0.0.5:8188/v1' });
    expect('imagesUrl' in plain!).toBe(false);
    const chat = await resolveRegistryModel('my-comfy:chat-model', 'u1');
    expect('imagesUrl' in chat!).toBe(false);
    expect(chat!.image).toBeUndefined();
  });
});
