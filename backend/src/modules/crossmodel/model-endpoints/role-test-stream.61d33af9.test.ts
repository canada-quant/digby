/**
 * Ticket 61d33af9 (2026-10-10): the endpoint test for image_generation models
 * aborted at ~55 s against real backends that answer at ~118 s (Caddy
 * llm-access.log: three POST /images/generations, duration 54.9 s, status 0 =
 * OUR axios closing; the backend completed every one HTTP 200 at ~118 s).
 *
 * Root cause: IMAGE_PROBE_TIMEOUT_MS = 55 s (image-generate.ts) — the admin
 * Test probe's outbound budget, deadline-clamped into every axios attempt —
 * cut a healthy-but-slow self-hosted image backend. Additionally, even with a
 * raised budget a JSON POST held open > 60 s dies at the ALB's idle timeout
 * (live-verified 60 s on digby-alb, 2026-10-10), so the answer must DELIVER
 * over an SSE stream with keepalives.
 *
 * This file replays the class at three layers:
 *   1. the budget — a 118 s probe completes under the 180 s budget (pre-fix it
 *      was cut at 55 s);
 *   2. the hard cap — a probe that never settles answers at 180 s + grace
 *      with a typed failure, never a hang;
 *   3. the STREAM twin — testModelRoleStream delivers the same result over
 *      keepalive frames and a terminal result frame, and the HTTP route
 *      (POST /admin/model-roles/test/stream) answers text/event-stream that
 *      flushes before the probe settles.
 *
 * 61d33af9 pins: IMAGE_PROBE_TIMEOUT_MS 55_000 → 180_000; imageProbeTimeoutMs
 * env clamp (55 s floor, 300 s ceiling, IMAGE_PROBE_TIMEOUT_DISABLED=1 legacy);
 * TEST_MODEL_ROLE_CAP_MS 120 s → 190 s (the agent tool must not cut the
 * 180 s probe); capability-detect's image group budget follows
 * imageProbeTimeoutMs (was 20 + 60 = 80 s outer guard).
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
jest.mock('../../../../src/modules/crossmodel/memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

const mockResolveRegistryModel = jest.fn();
jest.mock('./model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userPreferences: { findUnique: (...a: any[]) => mockPrefFindUnique(...a) } },
}));
const mockPrefFindUnique = jest.fn();
const mockResolveOneCodingPick = jest.fn();
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: (...a: any[]) => mockResolveOneCodingPick(...a),
}));

// The REAL image-generate module (its table + imageProbeTimeoutMs are part of
// the replay); only the live probe is mocked.
const mockProbeImageGenerate = jest.fn();
jest.mock('../image-generate', () => ({
  __esModule: true,
  ...jest.requireActual('../image-generate'),
  probeImageGenerate: (...a: any[]) => mockProbeImageGenerate(...a),
}));

jest.mock('axios');

import {
  IMAGE_PROBE_TIMEOUT_MS,
  IMAGE_PROBE_LEGACY_TIMEOUT_MS,
  imageProbeTimeoutMs,
} from '../image-generate';
import { testModelRole, testModelRoleStream, IMAGE_PROBE_HARD_CAP_GRACE_MS } from './model-roles.service';
import { TEST_MODEL_ROLE_CAP_MS } from '../platform/fleet-ops-tools';

const REG_IMAGE = { id: 'r1', coding: false, model: 'qwen-image-2.1', label: 'cql-litellm', baseUrl: 'http://10.0.0.5:4001/v1', image: true as const, apiKey: 'sk-reg' };

describe('ticket 61d33af9 — the image-seat endpoint test vs a ~118 s real backend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    delete process.env.IMAGE_PROBE_TIMEOUT_MS;
    delete process.env.IMAGE_PROBE_TIMEOUT_DISABLED;
    process.env.ZAI_API_KEY = 'id.secret';
    process.env.DASHSCOPE_API_KEY = 'sk-d';
    mockStoreGet.mockResolvedValue({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockPrefFindUnique.mockResolvedValue(null);
    mockResolveOneCodingPick.mockImplementation(async (v: string) => v);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.IMAGE_PROBE_TIMEOUT_MS;
    delete process.env.IMAGE_PROBE_TIMEOUT_DISABLED;
  });

  it('the budget is 180 s — ABOVE the ~118 s a real self-hosted image backend takes at the OpenAI Images default shape (the 55 s cut is gone)', () => {
    // The exact shape Caddy logged: our axios closed at 54.9 s while the backend
    // answered HTTP 200 at ~118 s (15.4 s fixed + ~5.1 s/step × 20 steps).
    expect(IMAGE_PROBE_TIMEOUT_MS).toBe(180_000);
    expect(IMAGE_PROBE_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(imageProbeTimeoutMs()).toBe(180_000);
    // The legacy 55 s stays as the clamp floor + the DISABLED restore value.
    expect(IMAGE_PROBE_LEGACY_TIMEOUT_MS).toBe(55_000);
    process.env.IMAGE_PROBE_TIMEOUT_DISABLED = '1';
    expect(imageProbeTimeoutMs()).toBe(55_000);
    delete process.env.IMAGE_PROBE_TIMEOUT_DISABLED;
    // The env override clamps into [55 s, 300 s].
    process.env.IMAGE_PROBE_TIMEOUT_MS = '240000';
    expect(imageProbeTimeoutMs()).toBe(240_000);
    process.env.IMAGE_PROBE_TIMEOUT_MS = '10'; // below the floor → clamped up
    expect(imageProbeTimeoutMs()).toBe(55_000);
    process.env.IMAGE_PROBE_TIMEOUT_MS = '999999'; // above the ceiling → clamped down
    expect(imageProbeTimeoutMs()).toBe(300_000);
    delete process.env.IMAGE_PROBE_TIMEOUT_MS;
  });

  it('the agent tool cap sits ABOVE the 180 s probe (190 s) so test_model_role answers the probe, not its own wall-clock cut', () => {
    expect(TEST_MODEL_ROLE_CAP_MS).toBe(190_000);
    expect(TEST_MODEL_ROLE_CAP_MS).toBeGreaterThan(IMAGE_PROBE_TIMEOUT_MS);
  });

  it('a 118 s probe — the real backend latency — now COMPLETES (pre-fix it was cut at 55 s)', async () => {
    mockProbeImageGenerate.mockImplementation(async (_spec: string, budgetMs: number) => {
      // The backend answers at 118 s; pre-fix the 55 s budget cut it at 54.9 s.
      expect(budgetMs).toBe(180_000);
      return {
        ok: true, latencyMs: 118_000, detail: 'qwen-image-2.1 OK — 512×512 image/png, 349,328 bytes (custom, 118.0s)',
        image: { mediaType: 'image/png', data: 'AAAA' },
      };
    });
    const r = await testModelRole('image_generate', 'cql-litellm:qwen-image-2.1');
    expect(r).toMatchObject({ ok: true, target: 'cql-litellm:qwen-image-2.1' });
    expect(r.detail).toContain('118.0s');
    expect(r.image).toEqual({ mediaType: 'image/png', data: 'AAAA' });
    expect(mockProbeImageGenerate).toHaveBeenCalledWith('cql-litellm:qwen-image-2.1', 180_000);
  });

  it('a probe that never settles is a TYPED failure at 180 s + grace — the hard-cap wall still answers (review 2026-09-24 shape, rescaled)', async () => {
    jest.useFakeTimers();
    mockProbeImageGenerate.mockReturnValue(new Promise(() => { /* never settles */ }));
    const pending = testModelRole('image_generate', 'glm-image');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(IMAGE_PROBE_TIMEOUT_MS + IMAGE_PROBE_HARD_CAP_GRACE_MS + 10);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, target: 'glm-image', error: expect.stringContaining('did not finish within 185 s') });
  });

  it('04c8ffd1 (review B1): a per-entry imageTimeoutMs raises the Test budget with it — a 600 s entry is probed at 600 s, not cut at the stock 180 s', async () => {
    // The ticket's own scenario: the admin raises the entry timeout to unblock a
    // 5-10-min local backend; the Test button must probe at the RAISED budget,
    // not report "did not finish within 185 s" against the stock one.
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 600_000 });
    mockProbeImageGenerate.mockImplementation(async (_spec: string, budgetMs: number) => {
      expect(budgetMs).toBe(600_000); // raised with the entry — never the stock 180 s
      return { ok: true, latencyMs: 595_000, detail: 'qwen-image-2.1 OK — 512×512 image/png, 349,328 bytes (custom, 595.0s)', image: { mediaType: 'image/png', data: 'AAAA' } };
    });
    const r = await testModelRole('image_generate', 'cql-litellm:qwen-image-2.1');
    expect(r).toMatchObject({ ok: true, target: 'cql-litellm:qwen-image-2.1' });
    expect(mockProbeImageGenerate).toHaveBeenCalledWith('cql-litellm:qwen-image-2.1', 600_000);
  });

  it('04c8ffd1 (review B1): the hard cap FOLLOWS the raised budget — a never-settling raised probe answers at entry + grace, never at the stock 185 s', async () => {
    jest.useFakeTimers();
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 240_000 });
    mockProbeImageGenerate.mockReturnValue(new Promise(() => { /* never settles */ }));
    const pending = testModelRole('image_generate', 'cql-litellm:qwen-image-2.1');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // The stock wall (185 s) must NOT fire first: budget = max(180 s, 240 s entry).
    await jest.advanceTimersByTimeAsync(IMAGE_PROBE_TIMEOUT_MS + IMAGE_PROBE_HARD_CAP_GRACE_MS + 10);
    expect(await Promise.race([pending.then(() => 'settled'), Promise.resolve('still-running')])).toBe('still-running');
    await jest.advanceTimersByTimeAsync(240_000 - 180_000);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('did not finish within 245 s') });
  });

  it('the STREAM twin keepalives while the 118 s probe runs, then delivers ONE terminal result frame (the ALB 60 s idle path never sees silence)', async () => {
    jest.useFakeTimers();
    const frames: string[] = [];
    const write = (frame: string) => frames.push(frame);
    mockProbeImageGenerate.mockImplementation(async () => {
      // The probe is still running while keepalives fire — the frames BEFORE the
      // result must all be keepalive comments (the ALB path stays warm).
      await jest.advanceTimersByTimeAsync(118_000);
      return { ok: true, latencyMs: 118_000, detail: 'qwen-image-2.1 OK — 512×512 (custom, 118.0s)', image: { mediaType: 'image/png', data: 'AAAA' } };
    });
    const streamed = testModelRoleStream('image_generate', 'cql-litellm:qwen-image-2.1', undefined, write);
    for (let i = 0; i < 20; i++) await Promise.resolve(); // reach the image branch
    await jest.advanceTimersByTimeAsync(0);
    const r = await streamed;
    expect(r).toBeUndefined(); // the twin writes; it does not return the result
    // 118 s at a 15 s cadence → ≥ 7 keepalive frames before the answer.
    const keepalives = frames.filter(f => f.startsWith(': keepalive'));
    expect(keepalives.length).toBeGreaterThanOrEqual(7);
    const resultFrames = frames.filter(f => f.startsWith('data:'));
    expect(resultFrames).toHaveLength(1);
    const payload = JSON.parse(resultFrames[0].slice('data: '.length));
    expect(payload).toMatchObject({ type: 'result', result: { ok: true, target: 'cql-litellm:qwen-image-2.1', latencyMs: 118_000 } });
    expect(payload.result.detail).toContain('118.0s');
  });

  it('the STREAM twin carries the sync route\'s typed 400s (keyless built-in) as a failed result frame — the UI sees the same error', async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const frames: string[] = [];
    await testModelRoleStream('image_generate', '', undefined, (f: string) => frames.push(f));
    const resultFrames = frames.filter(f => f.startsWith('data:'));
    expect(resultFrames).toHaveLength(1);
    const payload = JSON.parse(resultFrames[0].slice('data: '.length));
    expect(payload.result.ok).toBe(false);
    expect(payload.result.error).toContain('DASHSCOPE_API_KEY');
    // No keepalive was needed — the error answered immediately.
    expect(frames.filter(f => f.startsWith(': keepalive'))).toHaveLength(0);
  });
});

describe('ticket 61d33af9 — the stream handler (controller testRoleStream, the POST /admin/model-roles/test/stream route body)', () => {
  // Route-level replay (review F6): exercise the CONTROLLER handler directly —
  // the repo's idiom for routes whose import chain pulls config/env (see
  // model-endpoints.detect.controller.test.ts) — with a recording res that
  // captures headers, flushHeaders, writes and end. The route WIRING is pinned
  // by the openapi drift guard (every discovered route documented).
  const mkRes = () => {
    const res: any = { headers: {} as Record<string, string>, frames: [] as string[], ended: false, statusCode: 200 };
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
    res.flushHeaders = jest.fn(() => { res.flushed = true; });
    res.write = (f: string) => { res.frames.push(f); return true; };
    res.end = jest.fn(() => { res.ended = true; return res; });
    Object.defineProperty(res, 'writableEnded', { get: () => res.ended });
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (o: any) => { res.jsonBody = o; return res; };
    return res;
  };
  const mkReq = (role: string | undefined, body: any): any => ({ user: role ? { id: 'u1', role } : undefined, body });

  // The controller's static import surface, mocked like the detect test.
  jest.mock('./model-endpoints.service', () => ({ getEndpoint: jest.fn() }));
  jest.mock('../platform/decision-gate-modes', () => ({}));
  jest.mock('../platform/decision-gate-readiness', () => ({}));
  jest.mock('../platform/decision-gate-backends', () => ({}));
  jest.mock('../platform/decision-gate-registry', () => ({}));
  jest.mock('../platform/decision-gate-rollout', () => ({}));
  jest.mock('../platform/decision-gate-spend', () => ({ decisionSpendByPurpose24h: jest.fn() }));
  jest.mock('./endpoint-verifier', () => ({ __esModule: true, verifyEndpointModel: jest.fn() }));
  const streamController = require('./model-endpoints.controller').default;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    process.env.ZAI_API_KEY = 'id.secret';
    process.env.DASHSCOPE_API_KEY = 'sk-d';
    mockStoreGet.mockResolvedValue({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockProbeImageGenerate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true, latencyMs: 30, detail: 'qwen-image-2.1 OK — 512×512 image/png (custom, 0.0s)', image: { mediaType: 'image/png', data: 'AAAA' } };
    });
  });

  it('sets the SSE headers, flushes them, writes ": open", then ONE terminal result frame, then ends', async () => {
    const res = mkRes();
    await streamController.testRoleStream(mkReq('ADMIN', { role: 'image_generate', model: 'cql-litellm:qwen-image-2.1' }), res, jest.fn());
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.frames[0]).toBe(': open\n\n');
    const resultFrames = res.frames.filter((f: string) => f.startsWith('data:'));
    expect(resultFrames).toHaveLength(1);
    const payload = JSON.parse(resultFrames[0].slice('data: '.length));
    expect(payload).toMatchObject({ type: 'result' });
    expect(payload.result).toMatchObject({ ok: true, target: 'cql-litellm:qwen-image-2.1' });
    expect(res.ended).toBe(true);
    // The result frame arrived AFTER the probe settled (it is the last write).
    expect(res.frames[res.frames.length - 1].startsWith('data:')).toBe(true);
  });

  it('the admin gate answers JSON 403 BEFORE any SSE write (no half-open stream)', async () => {
    for (const role of ['USER', undefined]) {
      const res = mkRes();
      await streamController.testRoleStream(mkReq(role, { role: 'image_generate' }), res, jest.fn());
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toBeUndefined(); // no SSE headers set
      expect(res.frames).toHaveLength(0);
      expect(res.jsonBody?.error).toMatch(/admin/i);
    }
    expect(mockProbeImageGenerate).not.toHaveBeenCalled();
  });

  it('a keyless built-in rides the stream as a FAILED result frame (the typed 400 the UI toasts)', async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const res = mkRes();
    await streamController.testRoleStream(mkReq('ADMIN', { role: 'image_generate', model: '' }), res, jest.fn());
    expect(res.statusCode).toBe(200); // the stream opened; the error is a frame
    const resultFrames = res.frames.filter((f: string) => f.startsWith('data:'));
    expect(resultFrames).toHaveLength(1);
    const payload = JSON.parse(resultFrames[0].slice('data: '.length));
    expect(payload.result.ok).toBe(false);
    expect(payload.result.error).toContain('DASHSCOPE_API_KEY');
    expect(mockProbeImageGenerate).not.toHaveBeenCalled();
  });
});
