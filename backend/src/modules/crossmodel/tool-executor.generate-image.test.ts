/**
 * generate_image tool (owner 2026-09-24: "add image generation model and admin
 * endpoint and defaults to generate images") — the ToolCache dispatch around
 * the leaf provider client (./image-generate, mocked here). Pins:
 *   - anonymous → the document sign-in message, no provider call;
 *   - argument validation runs BEFORE any slot/provider work;
 *   - success persists ONE GeneratedFile row (sniffed format/mime, base64
 *     data, the RUN's chatId, prompt+model in textContent), attaches one
 *     source:'generated' image with the fileId, records the metric, and the
 *     result string names the File id + the do-not-embed rule — never base64,
 *     never a provider URL;
 *   - the run's chat always wins over a model-supplied chatId;
 *   - caps are consumed BEFORE the provider call and REFUNDED on every failure
 *     (rate refusal, provider error, quota refusal); redis down → allowed;
 *   - reference resolution: other-user upload → not-found message, non-image
 *     upload → typed message, other-user file → not found; a good reference
 *     rides to the provider as sniffed bytes.
 * Scaffold: tool-executor.generated-file-attribution.test.ts + document-tools.test.ts.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPrisma: any = {
  generatedFile: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
  crossModelChat: { findFirst: jest.fn() },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: (...a: any[]) => mockLoadAttachment(...a) }));
jest.mock('./mcp-search', () => ({ __esModule: true, callMcpTool: jest.fn(async () => null), webToolsDegraded: jest.fn(() => false) }));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// The leaf provider client (BE-1's module) — only its surface matters here.
const mockGenerateImage: jest.Mock = jest.fn();
// 09a03aef: the leaf's substitution line helper — pure string builder, real
// implementation re-created here so the tool's NOTE line is asserted against
// the exact sentence shape the leaf produces (a virtual mock cannot import
// the real leaf without breaking the jest.mock hoist).
const describeImageSubstitutionReal = (img: any): string => {
  if (!img?.substitutedFor) return '';
  const reason = img.substitutionReason === 'timeout' ? 'timed out' : img.substitutionReason === 'unavailable' ? 'was unavailable' : 'failed';
  return `served by ${img.spec} (fallback) — the seated model ${img.substitutedFor} ${reason} before the image was generated`;
};
jest.mock('./image-generate', () => ({
  __esModule: true,
  generateImage: (...a: any[]) => mockGenerateImage(...a),
  describeImageSubstitution: (img: any) => describeImageSubstitutionReal(img),
  ImageGenerationError: class ImageGenerationError extends Error { constructor(public code: string, message: string) { super(message); } },
}), { virtual: true });

// Redis stand-in with real counters so the consume/refund arithmetic is observable.
const mockCounters = new Map<string, number>();
const mockRedis = {
  incr: jest.fn(async (k: string) => { const n = (mockCounters.get(k) ?? 0) + 1; mockCounters.set(k, n); return n; }),
  decr: jest.fn(async (k: string) => { const n = (mockCounters.get(k) ?? 0) - 1; mockCounters.set(k, n); return n; }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// platform/rate-slots (BE-1's leaf) — the verbatim account-tools semantics, so
// the tool's consume-before / refund-on-failure contract is exercised for real.
jest.mock('./platform/rate-slots', () => ({
  __esModule: true,
  HOUR_KEY_TTL: 2 * 3600,
  DAY_KEY_TTL: 2 * 86_400,
  rateKeys: (prefix: string, userId: string, sessionId: string, now = new Date()) => {
    const iso = now.toISOString();
    return { dayKey: `${prefix}:user:${userId}:${iso.slice(0, 10)}`, hourKey: `${prefix}:chat:${sessionId}:${iso.slice(0, 13)}` };
  },
  consumeRateSlots: async (redis: any, slots: Array<{ key: string; cap: number; ttlSec: number; scope: string }>) => {
    const taken: string[] = [];
    for (const slot of slots) {
      const n = await redis.incr(slot.key);
      await redis.expire(slot.key, slot.ttlSec);
      taken.push(slot.key);
      if (n > slot.cap) {
        for (const k of taken) await redis.decr(k).catch(() => {});
        return { ok: false, scope: slot.scope, cap: slot.cap };
      }
    }
    return { ok: true };
  },
}), { virtual: true });

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { IMAGE_GENERATION: 'image_generation' },
}));

import { ToolCache, storeGeneratedImage, GeneratedFileQuotaError, inlineGeneratedPath, preflightImageQuota, IMAGE_QUOTA_ESTIMATE_BYTES } from './tool-executor';

const SIGN_IN_MSG = 'Document tools need a signed-in account. Ask the user to sign in, then try again.';
const RUN_CHAT = '11111111-aaaa-4bbb-8ccc-000000000001';
const OTHER_CHAT = '22222222-aaaa-4bbb-8ccc-000000000002';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body-bytes')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body-bytes')]);

const okImage = (over: Partial<any> = {}) => ({
  bytes: PNG, mimeType: 'image/png', width: 1024, height: 1024, model: 'qwen-image-3.0', provider: 'dashscope',
  spec: 'qwen-image-3.0', latencyMs: 4200, referenceMode: 'none', ...over,
});

const hourKeyFor = (chatKey: string) => `image:chat:${chatKey}:${new Date().toISOString().slice(0, 13)}`;
const dayKeyFor = (userId: string) => `image:user:${userId}:${new Date().toISOString().slice(0, 10)}`;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockCounters.clear();
  delete process.env.IMAGE_CHAT_HOURLY_CAP;
  delete process.env.IMAGE_USER_DAILY_CAP;
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
  mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { size: 1024 } });
  mockPrisma.generatedFile.create.mockImplementation(async ({ data }: any) => ({ id: 'file-1', ...data }));
  mockPrisma.generatedFile.findFirst.mockResolvedValue(null);
  mockLoadAttachment.mockResolvedValue(null);
  mockGenerateImage.mockResolvedValue(okImage());
});

describe('generate_image — gating + validation', () => {
  it('anonymous → the sign-in message, no provider call, no slot taken', async () => {
    const out = await new ToolCache(null).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toBe(SIGN_IN_MSG);
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('missing / short prompt → argument error before any slot or provider work', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    expect(await tc.getOrExecute('generate_image', {})).toMatch(/needs a `prompt`/);
    expect(await tc.getOrExecute('generate_image', { prompt: 'ab' })).toMatch(/needs a `prompt`/);
    expect(await tc.getOrExecute('generate_image', { prompt: 'x'.repeat(2001) })).toMatch(/keep it under 2000/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('bad aspect / oversized style / oversized negativePrompt → typed argument errors', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox', aspect: 'circle' })).toMatch(/invalid aspect "circle"/);
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox', style: 's'.repeat(201) })).toMatch(/`style` must be 200/);
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox', negativePrompt: 'n'.repeat(501) })).toMatch(/`negativePrompt` must be 500/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('is never served from the request cache (two identical calls → two provider calls)', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(mockGenerateImage).toHaveBeenCalledTimes(2);
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(2);
  });
});

describe('generate_image — success path', () => {
  it('stores ONE GeneratedFile (png, sniffed mime, base64, run chatId, prompt+model text), attaches the image, records the metric, returns the do-not-embed result', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    const out = await tc.getOrExecute('generate_image', { prompt: 'A red fox curled up in fresh snow, golden hour, 35mm film photo', aspect: 'landscape', style: 'warm tones' });

    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockGenerateImage.mock.calls[0][0]).toEqual({
      prompt: 'A red fox curled up in fresh snow, golden hour, 35mm film photo', aspect: 'landscape', style: 'warm tones', polish: false, negativePrompt: undefined, reference: undefined,
    });

    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.generatedFile.create.mock.calls[0][0].data;
    expect(row.userId).toBe('u1');
    expect(row.chatId).toBe(RUN_CHAT);
    expect(row.format).toBe('png');
    expect(row.mimeType).toBe('image/png');
    expect(row.size).toBe(PNG.length);
    expect(row.data).toBe(PNG.toString('base64'));
    expect(row.filename).toMatch(/^image-\d{8}-\d{6}-a-red-fox-curled-up-in-fresh-sno\.png$/); // slug capped at 32 chars
    expect(row.textContent).toContain('prompt: "A red fox curled up in fresh snow');
    expect(row.textContent).toContain('qwen-image-3.0 (dashscope)');
    expect(row.textContent).toContain('1024×1024');
    expect(row.textContent).toContain('aspect landscape');

    const imgs = tc.takeAttachedImages();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ source: 'generated', fileId: 'file-1', mediaType: 'image/png', data: PNG.toString('base64') });
    expect(imgs[0].prompt).toBe('A red fox curled up in fresh snow, golden hour, 35mm film photo');
    expect(imgs[0].name).toMatch(/^Generated · 1024×1024 · "A red fox curled up in fresh snow, golden hour, 35mm film ph…"$/);
    expect(tc.takeAttachedImages()).toEqual([]); // drained

    expect(out).toContain('File id: file-1');
    expect(out).toContain('ALREADY displayed in the chat');
    expect(out).toContain('/files');
    expect(out).toContain('do not embed it again');
    expect(out).toContain('1024×1024 image/png');
    expect(out).toContain('qwen-image-3.0 via dashscope');
    expect(out).not.toContain(PNG.toString('base64'));
    expect(out).not.toMatch(/https?:\/\//); // never a provider URL
    expect(out).not.toMatch(/data:image\/|;base64,/); // never a data URI

    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image_generation', sessionId: RUN_CHAT, value: 4200, unit: 'ms',
      meta: expect.objectContaining({ surface: 'tool', ok: true, model: 'qwen-image-3.0', provider: 'dashscope', aspect: 'landscape', referenceMode: 'none', bytes: PNG.length }),
    }));
  });

  it('takes one hourly (chat) + one daily (user) slot on success — no refund', async () => {
    await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(1);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(1);
    expect(mockRedis.decr).not.toHaveBeenCalled();
  });

  it("the run's chat always wins — a model-supplied different chatId is ignored (no lookup)", async () => {
    await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow', chatId: OTHER_CHAT });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBe(RUN_CHAT);
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
  });

  it("a chat-less run may name one of the user's OWN chats; a foreign chat files it unattributed", async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: OTHER_CHAT });
    await new ToolCache('u1', null).getOrExecute('generate_image', { prompt: 'a red fox in the snow', chatId: OTHER_CHAT });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBe(OTHER_CHAT);
    // chat-less runs meter the hourly bucket per USER, never a global bucket
    expect(mockCounters.get(hourKeyFor('user-u1'))).toBe(1);

    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce(null);
    await new ToolCache('u1', null).getOrExecute('generate_image', { prompt: 'a red fox in the snow', chatId: OTHER_CHAT });
    expect(mockPrisma.generatedFile.create.mock.calls[1][0].data.chatId).toBeNull();
  });

  it('JPEG bytes labelled image/png by the provider are stored as jpg / image/jpeg (sniff wins)', async () => {
    mockGenerateImage.mockResolvedValue(okImage({ bytes: JPEG, mimeType: 'image/png', model: 'glm-image', provider: 'zai', spec: 'glm-image' }));
    const tc = new ToolCache('u1', RUN_CHAT);
    const out = await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    const row = mockPrisma.generatedFile.create.mock.calls[0][0].data;
    expect(row.format).toBe('jpg');
    expect(row.mimeType).toBe('image/jpeg');
    expect(row.filename).toMatch(/\.jpg$/);
    expect(tc.takeAttachedImages()[0].mediaType).toBe('image/jpeg');
    expect(out).toContain('image/jpeg');
  });

  it('a reference from an earlier generated image rides to the provider as sniffed bytes and the result names the mode', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'ref-1', userId: 'u1', filename: 'earlier.png', format: 'png', mimeType: 'image/png', data: PNG.toString('base64') });
    mockGenerateImage.mockResolvedValue(okImage({ referenceMode: 'native' }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'the same fox, but at night', referenceFileId: 'ref-1' });
    expect(mockPrisma.generatedFile.findFirst).toHaveBeenCalledWith({ where: { id: 'ref-1', userId: 'u1' } });
    const input = mockGenerateImage.mock.calls[0][0];
    expect(input.reference).toEqual({ bytes: PNG, mimeType: 'image/png', name: 'earlier.png' });
    expect(out).toContain('reference image used natively');
    expect(out).not.toContain('fallback leg');
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ referenceMode: 'native' }) }));
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).not.toHaveProperty('editLegSource', 'fallback');
  });

  it('WI-P 2026-09-25: an edit served by an implicit same-key fallback leg names the fallback in the receipt and stamps editLegSource in the metric', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'ref-1', userId: 'u1', filename: 'earlier.png', format: 'png', mimeType: 'image/png', data: PNG.toString('base64') });
    mockGenerateImage.mockResolvedValue(okImage({ model: 'qwen-image-2.0', spec: 'qwen-image-2.0', referenceMode: 'native', editLegSource: 'fallback' }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'the same fox, but at night', referenceFileId: 'ref-1' });
    expect(out).toContain('reference image used natively (on a same-key edit-capable fallback leg, not the seated model)');
    expect(out).not.toContain('DESCRIBED');
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image_generation',
      meta: expect.objectContaining({ surface: 'tool', ok: true, model: 'qwen-image-2.0', spec: 'qwen-image-2.0', referenceMode: 'native', editLegSource: 'fallback' }),
    }));
  });

  it('09a03aef: a chain serve on a fallback leg STAMPS the substitution — the tool result carries a NOTE line and the image_generation metric carries substitutedFor + substitutionReason (never a silent swap)', async () => {
    // The incident shape: the seated custom model timed out at the chain
    // timeout and z-image-turbo served.
    mockGenerateImage.mockResolvedValue(okImage({ model: 'z-image-turbo', provider: 'dashscope', spec: 'z-image-turbo', substitutedFor: 'my-comfy:sdxl', substitutionReason: 'timeout', width: 864, height: 1152 }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a quiet harbour at dawn', aspect: 'portrait' });
    // The result names what served AND what the seat picked, with the remedy.
    expect(out).toContain('NOTE: served by z-image-turbo (fallback) — the seated model my-comfy:sdxl timed out');
    expect(out).toContain('imageTimeoutMs');
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image_generation',
      meta: expect.objectContaining({
        surface: 'tool', ok: true, model: 'z-image-turbo', spec: 'z-image-turbo',
        substitutedFor: 'my-comfy:sdxl', substitutionReason: 'timeout',
      }),
    }));
  });

  it('09a03aef: no substitution marker when the seated model serves — the result stays byte-identical to the pre-fix shape (no NOTE line, no metric keys)', async () => {
    mockGenerateImage.mockResolvedValue(okImage());
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a quiet harbour at dawn' });
    expect(out).not.toContain('NOTE:');
    expect(out).toContain('File id:');
    await flush();
    const metas = mockRecordLoopMetric.mock.calls.filter(c => c[0]?.kind === 'image_generation').map(c => c[0].meta as Record<string, unknown>);
    expect(metas.length).toBeGreaterThan(0);
    for (const m of metas) expect('substitutedFor' in m).toBe(false);
  });

  it('a described reference is reported as such', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'image', filename: 'sketch.png', mimeType: 'image/png', base64: PNG.toString('base64'), ownerUserId: 'u1' });
    mockGenerateImage.mockResolvedValue(okImage({ referenceMode: 'described' }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'render this sketch as a poster', referenceUploadId: 'up-1' });
    expect(mockGenerateImage.mock.calls[0][0].reference).toEqual({ bytes: PNG, mimeType: 'image/png', name: 'sketch.png' });
    expect(out).toContain('DESCRIBED by the Image reader seat');
  });
});

describe('generate_image — caps (consumed before the call, refunded on failure)', () => {
  it('hourly cap exceeded → refusal text, no provider call, no row, counters back where they were', async () => {
    process.env.IMAGE_CHAT_HOURLY_CAP = '2';
    mockCounters.set(hourKeyFor(RUN_CHAT), 2);
    mockCounters.set(dayKeyFor('u1'), 5);
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toBe('This chat has already generated 2 images this hour (cap 2/hour per chat). Tell the user and do not retry this run.');
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(2);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(5); // never touched — the hourly slot overflowed first
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image_generation', meta: expect.objectContaining({ rateLimited: true, scope: 'chat_hourly', cap: 2 }) }));
  });

  it('daily cap exceeded → its refusal, the hourly slot it took is given back', async () => {
    process.env.IMAGE_USER_DAILY_CAP = '3';
    mockCounters.set(dayKeyFor('u1'), 3);
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toBe('The user has already generated 3 images today (cap 3/day). Tell the user; do not retry this run.');
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(0);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(3);
  });

  it('defaults are 8/hour/chat and 40/day/user', async () => {
    mockCounters.set(hourKeyFor(RUN_CHAT), 8);
    expect(await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toMatch(/cap 8\/hour per chat/);
    mockCounters.clear();
    mockCounters.set(dayKeyFor('u1'), 40);
    expect(await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toMatch(/cap 40\/day/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('a provider failure refunds BOTH counters and returns a retry-once message (no row, metric ok:false)', async () => {
    mockGenerateImage.mockRejectedValue(Object.assign(new Error('DashScope 500: internal'), { code: 'provider' }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toMatch(/^Image generation failed: DashScope 500: internal\. You may retry ONCE/);
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(0);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(0);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ ok: false, code: 'provider', surface: 'tool' }) }));
  });

  it('typed failures: refused → content-policy message (no retry), unconfigured → seat message, timeout → retry-once', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    mockGenerateImage.mockRejectedValueOnce(Object.assign(new Error('DataInspectionFailed'), { code: 'refused' }));
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toMatch(/refused this prompt \(content policy\): DataInspectionFailed.*do not retry the same prompt/);
    mockGenerateImage.mockRejectedValueOnce(Object.assign(new Error('no image seat is servable — add DASHSCOPE_API_KEY'), { code: 'unconfigured' }));
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toMatch(/not configured on this Digby: no image seat is servable — add DASHSCOPE_API_KEY\. Tell the user/);
    mockGenerateImage.mockRejectedValueOnce(Object.assign(new Error('60s'), { code: 'timeout' }));
    expect(await tc.getOrExecute('generate_image', { prompt: 'a red fox in the snow' })).toMatch(/timed out \(60s\)\. You may retry ONCE/);
    // every failure refunded — three attempts, nothing admitted
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(0);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(0);
  });

  it('a provider error message never leaks a credential', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-super-secret-dashscope-key-123';
    try {
      mockGenerateImage.mockRejectedValue(Object.assign(new Error('401 for Bearer sk-super-secret-dashscope-key-123'), { code: 'provider' }));
      const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
      expect(out).not.toContain('sk-super-secret-dashscope-key-123');
      expect(out).toContain('[redacted]');
    } finally {
      delete process.env.DASHSCOPE_API_KEY;
    }
  });

  it('a full account (file count) is refused BEFORE any slot or paid provider call, with a do-not-retry message (review 2026-09-24)', async () => {
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { size: 1024 } });
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toMatch(/^Storage quota reached: this account already has 100 generated files \(limit 100\)/);
    expect(out).toContain('Do not retry generate_image this run; only the user can free space.');
    expect(out).not.toMatch(/and then retry/);
    expect(mockGenerateImage).not.toHaveBeenCalled();   // no provider spend
    expect(mockRedis.incr).not.toHaveBeenCalled();        // no slot taken → nothing to refund
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBeUndefined();
    expect(mockCounters.get(dayKeyFor('u1'))).toBeUndefined();
  });

  it('a full account (byte cap, estimated at IMAGE_QUOTA_ESTIMATE_BYTES) is refused pre-flight too', async () => {
    expect(IMAGE_QUOTA_ESTIMATE_BYTES).toBe(1536 * 1024);
    // ~200 MB of base64 already stored: any 1.5 MB image would exceed the cap.
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 10 }, _sum: { size: 150 * 1024 * 1024 } });
    expect(await preflightImageQuota('u1')).toMatch(/^Storage quota reached: this account's generated files already use ~200\.0MB of the 200MB storage cap and an image would exceed it/);
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toContain('Do not retry generate_image this run');
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockRedis.incr).not.toHaveBeenCalled();
    // A comfortable account passes pre-flight (null).
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { size: 1024 } });
    expect(await preflightImageQuota('u1')).toBeNull();
  });

  it('the byte-accurate post-call check still guards an image heavier than the estimate: refused verbatim, slots refunded, no row', async () => {
    // Pre-flight (1.5 MB estimate) passes; the real 2.4 MB image tips the cap.
    mockPrisma.generatedFile.aggregate
      .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { size: 1024 } })
      .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { size: 150 * 1024 * 1024 } });
    mockGenerateImage.mockResolvedValueOnce(okImage({ bytes: Buffer.concat([PNG, Buffer.alloc(2_400_000)]) }));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toMatch(/^Storage quota reached: this account's generated files already use/);
    expect(out).toContain('Do not retry generate_image this run');
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
    expect(mockCounters.get(hourKeyFor(RUN_CHAT))).toBe(0);
    expect(mockCounters.get(dayKeyFor('u1'))).toBe(0);
  });

  it('redis unreachable → allowed (fail-open), generation proceeds, nothing to refund', async () => {
    mockRedis.incr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'a red fox in the snow' });
    expect(out).toContain('File id: file-1');
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockRedis.decr).not.toHaveBeenCalled();
  });
});

describe('generate_image — reference resolution', () => {
  it("an upload owned by ANOTHER user is treated as expired/not-found (no existence leak); the user's own image upload is fine", async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'image', filename: 'theirs.png', mimeType: 'image/png', base64: PNG.toString('base64'), ownerUserId: 'someone-else' });
    const out = await new ToolCache('u1', RUN_CHAT).getOrExecute('generate_image', { prompt: 'restyle this', referenceUploadId: 'up-x' });
    expect(out).toMatch(/^Upload up-x expired or was not found/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockRedis.incr).not.toHaveBeenCalled(); // resolved before any slot is taken
  });

  it('a non-image upload → typed message; a mislabelled non-image payload → sniff refusal', async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    mockLoadAttachment.mockResolvedValueOnce({ type: 'pdf', filename: 'form.pdf', mimeType: 'application/pdf', base64: 'JVBERi0=', ownerUserId: 'u1' });
    expect(await tc.getOrExecute('generate_image', { prompt: 'restyle this', referenceUploadId: 'up-pdf' })).toMatch(/^Upload up-pdf is a pdf, not an image/);
    mockLoadAttachment.mockResolvedValueOnce({ type: 'image', filename: 'fake.png', mimeType: 'image/png', base64: Buffer.from('not really an image').toString('base64'), ownerUserId: 'u1' });
    expect(await tc.getOrExecute('generate_image', { prompt: 'restyle this', referenceUploadId: 'up-fake' })).toMatch(/is not a PNG, JPEG or WebP image/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("a referenceFileId that is not the user's → not found; a non-image generated file → typed message", async () => {
    const tc = new ToolCache('u1', RUN_CHAT);
    mockPrisma.generatedFile.findFirst.mockResolvedValueOnce(null);
    expect(await tc.getOrExecute('generate_image', { prompt: 'restyle this', referenceFileId: 'ref-other' })).toMatch(/^No generated file with id ref-other belongs to this user/);
    mockPrisma.generatedFile.findFirst.mockResolvedValueOnce({ id: 'ref-doc', userId: 'u1', filename: 'report.pdf', format: 'pdf', mimeType: 'application/pdf', data: 'JVBERi0=' });
    expect(await tc.getOrExecute('generate_image', { prompt: 'restyle this', referenceFileId: 'ref-doc' })).toMatch(/^File report\.pdf is a pdf, not an image/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });
});

describe('storeGeneratedImage / inlineGeneratedPath (shared with the REST mirror)', () => {
  it('writes the row and returns { id, filename }; the quota refusal is a GeneratedFileQuotaError', async () => {
    const stored = await storeGeneratedImage('u1', RUN_CHAT, okImage() as any, { prompt: 'Logo concept: "Digby" wordmark', aspect: 'square' });
    expect(stored).toEqual({ id: 'file-1', filename: expect.stringMatching(/^image-\d{8}-\d{6}-logo-concept-digby-wordmark\.png$/) });
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { size: 1024 } });
    await expect(storeGeneratedImage('u1', null, okImage() as any, { prompt: 'x' })).rejects.toBeInstanceOf(GeneratedFileQuotaError);
  });

  it('inlineGeneratedPath is the image-only inline route', () => {
    expect(inlineGeneratedPath('abc')).toBe('/api/crossmodel/generated-files/abc/inline');
  });
});
