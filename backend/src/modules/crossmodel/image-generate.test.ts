/**
 * image-generate.ts — the Image generator seat's runtime (2026-09-24).
 *
 * Pins (every request/response shape is what the 2026-09-24 live probe measured):
 *   - DashScope leg: the native multimodal-generation body (messages/text, size
 *     W*H, n 1, prompt_extend off, watermark off, negative_prompt) with Bearer
 *     DASHSCOPE_API_KEY; output.choices[0].message.content[0].image is
 *     DOWNLOADED inside the call; a reference rides as an image part BEFORE the
 *     text part with the size sent explicitly.
 *   - Z.AI / OpenAI-shaped leg: {model, prompt, size WxH, n 1, response_format
 *     b64_json} to /images/generations, NEVER image input; JPEG bytes labelled
 *     png are sniffed to image/jpeg; glm-image retries once on HTTP 500 (code
 *     1234); b64_json accepted from custom endpoints.
 *   - Chain: seat override → custom fallback → z-image-turbo → glm-image →
 *     cogview-4-250304, deduplicated; keyless legs skipped without a request;
 *     a 429 moves on (or waits once on a short Retry-After); a content-filter
 *     refusal STOPS the chain; a stale / unflagged registry override is skipped
 *     with a warn; `spec` pins one leg; `probe` uses the leg's probeSize.
 *   - Reference: text-only legs are dropped; the same-key IMAGE_EDIT_FALLBACK_CHAIN
 *     legs join (WI-P 2026-09-25: even when the seat chain has NO edit leg —
 *     editLegSource 'fallback'); with none servable the reference is
 *     described ONCE by the Image reader and referenceMode is 'described'.
 *   - Nothing servable → ImageGenerationError 'unconfigured' naming the seat
 *     page + env vars, zero requests. No logger line ever carries an API key.
 *   - Drift guard: IMAGE_BUILT_INS keys == model-roles IMAGE_BUILT_IN_OPTIONS.
 *
 * axios is mocked at the module boundary; the model-roles / registry /
 * image-describe seams are dynamically imported by image-generate.ts and mocked
 * here (the real model-roles module pulls config/database into the graph — its
 * static deps are mocked so the drift guard can requireActual it).
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockGetModelRoleOverrides = jest.fn();
const mockResolveRoleFallback = jest.fn();
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  getModelRoleOverrides: (...a: any[]) => mockGetModelRoleOverrides(...a),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...a),
  roleDefaultModel: (key: string, overrides: Record<string, string>) => overrides?.[key] || 'qwen-image-3.0',
}));
const mockResolveRegistryModel = jest.fn();
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
const mockDescribe = jest.fn();
jest.mock('./image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribe(...a),
}));
// The drift guard requireActual's model-roles.service — keep its static graph
// off prisma / config/env (which process.exit(1)s without env vars).
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));
jest.mock('./memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(), storePut: jest.fn() }));

import axios from 'axios';
import logger from '../../utils/logger';
import {
  generateImage, probeImageGenerate, imageSpecEnvKey, readImageDimensions, imageUnconfiguredMessage,
  ImageGenerationError, IMAGE_BUILT_INS, IMAGE_BUILT_IN_CHAIN, IMAGE_EDIT_FALLBACK_CHAIN, IMAGE_DEFAULT_MODEL, IMAGE_ASPECTS, IMAGE_PROBE_TIMEOUT_MS,
  imageCallBudgetMs, IMAGE_CALL_BUDGET_MAX_MS, imageCustomTimeoutMs, IMAGE_CUSTOM_TIMEOUT_MAX_MS,
  describeImageSubstitution, probeSizeScale, probeChainRepresentativeness,
} from './image-generate';
import { sniffMime } from './coding/chat-images';

const mockedPost = axios.post as jest.Mock;
const mockedGet = axios.get as jest.Mock;
const mockWarn = logger.warn as jest.Mock;
const mockInfo = logger.info as jest.Mock;

const DASHSCOPE_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ZAI_URL = 'https://api.z.ai/api/paas/v4/images/generations';
const ZAI_KEY = 'a1b2c3d4e5f6a1b2.SECRETsecretSECRET';

/** A PNG signature + IHDR carrying the given size (enough for the sniffer + the dimension reader). */
function png(width = 8, height = 8): Buffer {
  const b = Buffer.alloc(33, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
/** SOI + APP0 + SOF0(height, width) + EOI. */
function jpeg(width = 16, height = 12): Buffer {
  const app0 = Buffer.alloc(18, 0); app0[0] = 0xff; app0[1] = 0xe0; app0.writeUInt16BE(16, 2); app0.write('JFIF\0', 4, 'ascii');
  const sof = Buffer.alloc(19, 0); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
/** RIFF/WEBP with a lossy VP8 bitstream header carrying the given size. */
function webp(width = 20, height = 10): Buffer {
  const b = Buffer.alloc(30, 0);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'ascii'); b.write('VP8 ', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(width, 26); b.writeUInt16LE(height, 28);
  return b;
}

const dashscopeOk = (url = 'https://dashscope-oss.example/out.png', usage: Record<string, number> = {}) => ({
  data: { output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'image', image: url }] } }] }, usage, request_id: 'r1' },
});
const zaiOk = (url = 'https://mfile.z.ai/x.png?ufileattname=out_watermark.png') => ({ data: { created: 1, data: [{ url }] } });
const httpError = (status: number, data: any, headers: Record<string, string> = {}) => ({
  response: { status, statusText: 'x', data, headers }, message: `Request failed with status code ${status}`,
});

const REG_IMAGE = {
  url: 'http://10.0.0.5:8188/v1/chat/completions', baseUrl: 'http://10.0.0.5:8188/v1', apiKey: 'sk-registry-secret',
  model: 'sdxl', label: 'my-comfy', supportsVision: false, coding: false, matryoshka: false, thinkingOff: false, providerShape: 'openai_chat', image: true as const,
};

const ENV_KEYS = ['DASHSCOPE_API_KEY', 'ZAI_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
}
beforeEach(() => {
  jest.resetAllMocks();
  mockGetModelRoleOverrides.mockResolvedValue({});
  mockResolveRoleFallback.mockResolvedValue('');
  mockResolveRegistryModel.mockResolvedValue(null);
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  setEnv({});
});
afterEach(() => { setEnv(saved); });

describe('built-in table (drift guards)', () => {
  it('IMAGE_BUILT_INS keys equal model-roles IMAGE_BUILT_IN_OPTIONS; the chain and the default are built-ins', () => {
    const { IMAGE_BUILT_IN_OPTIONS, MODEL_ROLES } = jest.requireActual('./model-endpoints/model-roles.service');
    expect(Object.keys(IMAGE_BUILT_INS)).toEqual([...IMAGE_BUILT_IN_OPTIONS]);
    expect(IMAGE_BUILT_IN_CHAIN.every(id => id in IMAGE_BUILT_INS)).toBe(true);
    expect(IMAGE_BUILT_IN_CHAIN).toEqual(['z-image-turbo', 'glm-image', 'cogview-4-250304']);
    expect(IMAGE_DEFAULT_MODEL).toBe('qwen-image-3.0');
    expect(MODEL_ROLES.find((r: any) => r.key === 'image_generate').defaultModel).toBe(IMAGE_DEFAULT_MODEL);
  });

  it('every built-in names its provider key and a size for every aspect in its provider grammar (W*H DashScope, WxH Z.AI)', () => {
    for (const [id, m] of Object.entries(IMAGE_BUILT_INS)) {
      expect(imageSpecEnvKey(id)).toBe(m.provider === 'zai' ? 'ZAI_API_KEY' : 'DASHSCOPE_API_KEY');
      const sep = m.provider === 'zai' ? 'x' : '*';
      for (const a of IMAGE_ASPECTS) expect(m.sizes[a]).toMatch(new RegExp(`^\\d+\\${sep}\\d+$`));
      expect(m.probeSize).toMatch(new RegExp(`^\\d+\\${sep}\\d+$`));
      expect(m.timeoutMs).toBeGreaterThanOrEqual(60_000);
    }
    // Only the DashScope Qwen/Wan legs edit — Z.AI silently drops image input (probe 2026-09-24).
    expect(Object.entries(IMAGE_BUILT_INS).filter(([, m]) => m.edits).map(([id]) => id)).toEqual(['qwen-image-3.0', 'qwen-image-2.0', 'wan2.7-image']);
    expect(IMAGE_BUILT_INS['glm-image'].retries).toBe(1);
  });

  it('imageSpecEnvKey: colon specs and unknown ids → null', () => {
    expect(imageSpecEnvKey('my-comfy:sdxl')).toBeNull();
    expect(imageSpecEnvKey('dall-e-3')).toBeNull();
    expect(imageSpecEnvKey('')).toBeNull();
  });

  it('readImageDimensions reads PNG / JPEG / WebP headers; sniffMime is the shared magic-byte sniffer', () => {
    expect(readImageDimensions(png(1024, 768), 'image/png')).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(jpeg(1472, 1088), 'image/jpeg')).toEqual({ width: 1472, height: 1088 });
    expect(readImageDimensions(webp(640, 480), 'image/webp')).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(Buffer.from('<html>'), 'image/png')).toBeNull();
    expect(sniffMime(jpeg())).toBe('image/jpeg');
    expect(sniffMime(png())).toBe('image/png');
  });
});

describe('DashScope leg (native sync multimodal-generation route)', () => {
  it('posts the native body with Bearer DASHSCOPE_API_KEY and downloads output.choices[0].message.content[0].image', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockResolvedValueOnce(dashscopeOk('https://oss/out.png', { output_width: 1024, output_height: 1024 }));
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'A red bicycle on a beach' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(DASHSCOPE_URL);
    expect(body).toEqual({
      model: 'qwen-image-3.0',
      input: { messages: [{ role: 'user', content: [{ text: 'A red bicycle on a beach' }] }] },
      parameters: { size: '1024*1024', n: 1, prompt_extend: false, watermark: false },
    });
    expect(opts.headers.Authorization).toBe('Bearer sk-dash');
    expect(opts.timeout).toBe(60_000);
    expect(mockedGet).toHaveBeenCalledWith('https://oss/out.png', expect.objectContaining({ responseType: 'arraybuffer' }));
    expect(img).toMatchObject({ model: 'qwen-image-3.0', provider: 'dashscope', spec: 'qwen-image-3.0', mimeType: 'image/png', width: 1024, height: 1024, referenceMode: 'none' });
    expect(img.bytes.equals(png(1024, 1024))).toBe(true);
    expect(typeof img.latencyMs).toBe('number');
  });

  it('aspect picks the per-model size; style is appended; negative_prompt rides; polish turns prompt_extend on and doubles the timeout', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(1280, 720) });
    const img = await generateImage({ prompt: 'City skyline at dusk', aspect: 'wide', style: 'flat vector, two colours', negativePrompt: 'text, watermark', polish: true });
    const [, body, opts] = mockedPost.mock.calls[0];
    expect(body.input.messages[0].content).toEqual([{ text: 'City skyline at dusk\nStyle: flat vector, two colours' }]);
    expect(body.parameters).toEqual({ size: '1280*720', n: 1, prompt_extend: true, watermark: false, negative_prompt: 'text, watermark' });
    expect(opts.timeout).toBe(120_000);
    expect(img).toMatchObject({ width: 1280, height: 720 });
  });

  it('edit: the reference rides as an image part BEFORE the text part, size is sent explicitly, referenceMode is native', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    const ref = png(64, 64);
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'Change the boat to bright blue', reference: { bytes: ref, mimeType: 'image/png', name: 'boat.png' } });
    const [, body] = mockedPost.mock.calls[0];
    expect(body.input.messages[0].content).toEqual([
      { image: `data:image/png;base64,${ref.toString('base64')}` },
      { text: 'Change the boat to bright blue' },
    ]);
    expect(body.parameters.size).toBe('1024*1024');
    // An edit measured 42.9 s live — the plan's 120 s budget, like polish (review 2026-09-24).
    expect(mockedPost.mock.calls[0][2].timeout).toBe(120_000);
    expect(img.referenceMode).toBe('native');
    expect(img.editLegSource).toBe('seat'); // qwen-image-3.0 is the seat's own leg, not an implicit fallback
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('a 200 with a DataInspectionFailed code, or a 400 carrying it, is a REFUSAL that stops the chain (no second request)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockedPost.mockRejectedValueOnce(httpError(400, { code: 'DataInspectionFailed', message: 'Output data may contain inappropriate content.', request_id: 'r' }));
    await expect(generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'refused' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    mockedPost.mockClear();
    mockedPost.mockResolvedValueOnce({ data: { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' } });
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect(err.code).toBe('refused');
    expect(err.message).toContain('content-safety');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('a response without an image URL, or bytes that are not an image, fail the leg and the chain moves on', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    // qwen-image-3.0: no image in the choice → z-image-turbo: HTML instead of an image → nothing left (Z.AI keyless).
    mockedPost.mockResolvedValueOnce({ data: { output: { choices: [{ message: { content: [{ text: 'sorry' }] } }] } } });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: Buffer.from('<html>error page</html>') });
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err.code).toBe('provider');
    expect(err.message).toContain('z-image-turbo');
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['qwen-image-3.0', 'z-image-turbo']);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('leg qwen-image-3.0 (dashscope) failed'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('not a PNG/JPEG/WebP'));
  });
});

describe('Z.AI / OpenAI-shaped leg (/images/generations)', () => {
  it('glm-image override: posts {model, prompt, size WxH, n 1, response_format b64_json}, never image input; JPEG-as-png is sniffed to image/jpeg', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg(1024, 1024), headers: { 'content-type': 'image/png' } });
    const img = await generateImage({ prompt: 'A lighthouse', aspect: 'landscape' });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(ZAI_URL);
    expect(body).toEqual({ model: 'glm-image', prompt: 'A lighthouse', size: '1472x1088', n: 1, response_format: 'b64_json' });
    expect(opts.headers.Authorization).toBe(`Bearer ${ZAI_KEY}`);
    expect(opts.timeout).toBe(150_000);
    expect(img).toMatchObject({ model: 'glm-image', provider: 'zai', mimeType: 'image/jpeg', width: 1024, height: 1024 });
  });

  it('glm-image + polish sends quality hd; cogview never does', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    await generateImage({ prompt: 'x', polish: true });
    expect(mockedPost.mock.calls[0][1].quality).toBe('hd');
    mockedPost.mockClear();
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'cogview-4-250304' });
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    await generateImage({ prompt: 'x', polish: true });
    expect(mockedPost.mock.calls[0][1].quality).toBeUndefined();
  });

  it('glm-image retries ONCE on HTTP 500 code 1234 (seen live) before the chain moves on', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockedPost.mockRejectedValueOnce(httpError(500, { error: { code: '1234', message: 'Network error, please try again' } }));
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('glm-image');
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500 code 1234 — retrying once'));
    // cogview (retries 0): a 500 goes straight to the next leg.
    mockedPost.mockClear();
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'cogview-4-250304' });
    mockedPost.mockRejectedValueOnce(httpError(500, { error: { code: '1234' } }));
    mockedPost.mockRejectedValueOnce(httpError(500, { error: { code: '1234' } })); // glm-image attempt 1
    mockedPost.mockRejectedValueOnce(httpError(500, { error: { code: '1234' } })); // glm-image retry
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err.code).toBe('provider');
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['cogview-4-250304', 'glm-image', 'glm-image']);
  });

  it('a reference with only text-only legs servable is DESCRIBED once by the Image reader and never sent to Z.AI', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    const ref = png(64, 64);
    mockDescribe.mockResolvedValue('A wooden fishing boat moored at a pier, morning light.');
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    const img = await generateImage({ prompt: 'Make the boat blue', reference: { bytes: ref, mimeType: 'image/png', name: 'boat.png' } });
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockDescribe).toHaveBeenCalledWith(ref, 'image/png', 'boat.png');
    const [, body] = mockedPost.mock.calls[0];
    expect(body.model).toBe('glm-image');
    expect(body.prompt).toContain('Make the boat blue');
    expect(body.prompt).toContain('Reference image (described');
    expect(body.prompt).toContain('wooden fishing boat');
    expect(Object.keys(body)).toEqual(['model', 'prompt', 'size', 'n', 'response_format']);
    expect(img.referenceMode).toBe('described');
    expect(img.editLegSource).toBeUndefined(); // no native edit leg served
  });

  it('Image reader failure in described mode is an honest provider error (no silent text-only generation)', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockDescribe.mockRejectedValue(new Error('Image reader seat: ZAI 429'));
    const err = await generateImage({ prompt: 'x', reference: { bytes: png(), mimeType: 'image/png' } }).catch(e => e);
    expect(err.code).toBe('provider');
    expect(err.message).toContain('could not describe it');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('a content_filter answer without an image is a refusal (chain stops); code 1301 on a 400 too', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockedPost.mockResolvedValueOnce({ data: { data: [], content_filter: [{ role: 'assistant', level: 0 }] } });
    await expect(generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'refused' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    mockedPost.mockClear();
    mockedPost.mockRejectedValueOnce(httpError(400, { error: { code: '1301', message: 'sensitive content' } }));
    await expect(generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'refused' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('a registry model flagged [image] runs OpenAI-shaped at <baseUrl>/images/generations and accepts data[0].b64_json', async () => {
    setEnv({});
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockResolvedValueOnce({ data: { data: [{ b64_json: png(512, 512).toString('base64') }] } });
    const img = await generateImage({ prompt: 'A cat', aspect: 'portrait' });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('http://10.0.0.5:8188/v1/images/generations');
    expect(body).toEqual({ model: 'sdxl', prompt: 'A cat', size: '896x1152', n: 1, response_format: 'b64_json' });
    expect(opts.headers.Authorization).toBe('Bearer sk-registry-secret');
    expect(mockedGet).not.toHaveBeenCalled();
    expect(img).toMatchObject({ model: 'sdxl', provider: 'custom', spec: 'my-comfy:sdxl', mimeType: 'image/png', width: 512, height: 512 });
  });

  // Todo 87b020c4 (owner ruling oq_7af5537b, 2026-10-25): the seat-side
  // tailnet-direct flip — an [image] registry entry carrying imagesUrl routes
  // the leg to <imagesUrl>/images/generations; the unset case (the test above)
  // keeps the <baseUrl>-derived URL — the Cloudflare fallback. Chat traffic
  // resolves url/baseUrl and never reads imagesUrl.
  it('a registry [image] entry carrying imagesUrl posts to <imagesUrl>/images/generations (tailnet-direct), not the endpoint baseUrl', async () => {
    setEnv({});
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imagesUrl: 'http://100.64.0.1:4001/v1' });
    mockedPost.mockResolvedValueOnce({ data: { data: [{ b64_json: png(512, 512).toString('base64') }] } });
    const img = await generateImage({ prompt: 'A cat', aspect: 'portrait' });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe('http://100.64.0.1:4001/v1/images/generations');
    expect(body).toEqual({ model: 'sdxl', prompt: 'A cat', size: '896x1152', n: 1, response_format: 'b64_json' });
    expect(opts.headers.Authorization).toBe('Bearer sk-registry-secret');
    expect(mockedGet).not.toHaveBeenCalled();
    expect(img).toMatchObject({ model: 'sdxl', provider: 'custom', spec: 'my-comfy:sdxl', mimeType: 'image/png' });
  });
});

describe('chain resolution', () => {
  it('order: seat override → custom fallback → z-image-turbo → glm-image → cogview-4-250304, deduplicated; a 429 without Retry-After moves on', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRoleFallback.mockResolvedValue('wan2.7-image');
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })); // custom
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling.RateQuota' }));                            // wan2.7-image
    mockedPost.mockResolvedValueOnce(dashscopeOk());                                                                  // z-image-turbo
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'x' });
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['sdxl', 'wan2.7-image', 'z-image-turbo']);
    expect(img).toMatchObject({ model: 'z-image-turbo', spec: 'z-image-turbo', provider: 'dashscope' });
    expect(mockResolveRoleFallback).toHaveBeenCalledWith('image_generate');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('leg sdxl (custom) failed — connect ECONNREFUSED'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('leg wan2.7-image (dashscope) failed — HTTP 429'));
  });

  it('a 429 with a short Retry-After waits ONCE and retries the same leg', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling' }, { 'retry-after': '0' }));
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png() });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('qwen-image-3.0');
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['qwen-image-3.0', 'qwen-image-3.0']);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('rate-limited — waiting 0 ms once'));
    // A long Retry-After is not worth waiting for: next leg.
    mockedPost.mockClear();
    mockedPost.mockRejectedValueOnce(httpError(429, {}, { 'retry-after': '30' }));
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png() });
    const img2 = await generateImage({ prompt: 'x' });
    expect(img2.model).toBe('z-image-turbo');
  });

  it('keyless built-ins are skipped WITHOUT a request (only the Z.AI key set → glm-image serves)', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    const img = await generateImage({ prompt: 'x' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][0]).toBe(ZAI_URL);
    expect(img).toMatchObject({ model: 'glm-image', provider: 'zai' });
  });

  it('a stale registry override (no longer resolving) or one not flagged [image] is skipped with a warn; the built-ins serve', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'ghost:model' });
    mockResolveRegistryModel.mockResolvedValue(null);
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png() });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('z-image-turbo'); // the seat's stale value is skipped; qwen-image-3.0 is NOT re-added (the chain is z-image-turbo → …)
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('"ghost:model" no longer resolves'));
    mockWarn.mockClear(); mockedPost.mockClear();
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, image: undefined });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png() });
    await generateImage({ prompt: 'x' });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('not flagged [image]'));
    expect(mockedPost.mock.calls[0][0]).toBe(DASHSCOPE_URL);
  });

  it('`spec` pins exactly ONE leg (no fallback on failure); `probe` uses the leg probeSize and the caller budget bounds the timeout', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg(512, 512) });
    const img = await generateImage({ prompt: 'x', spec: 'cogview-4-250304', probe: true, polish: true, timeoutMs: 55_000 });
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(url).toBe(ZAI_URL);
    expect(body.size).toBe('512x512');
    expect(body.quality).toBeUndefined();
    expect(opts.timeout).toBeLessThanOrEqual(55_000);
    expect(img.spec).toBe('cogview-4-250304');
    expect(mockGetModelRoleOverrides).not.toHaveBeenCalled(); // the pinned leg never consults the seat chain
    mockedPost.mockClear();
    mockedPost.mockRejectedValueOnce(httpError(401, { error: { code: '1000', message: 'auth' } }));
    const err = await generateImage({ prompt: 'x', spec: 'qwen-image-3.0', probe: true }).catch(e => e);
    expect(err.code).toBe('provider');
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][1].parameters).toMatchObject({ size: '512*512', prompt_extend: false });
  });

  it('probeImageGenerate returns the thumbnail as base64 on success and a key-scrubbed detail on failure (never throws)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash-secret' });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(512, 512) });
    const ok = await probeImageGenerate('qwen-image-3.0');
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('qwen-image-3.0 OK — 512×512 image/png');
    expect(ok.image).toEqual({ mediaType: 'image/png', data: png(512, 512).toString('base64') });
    expect(IMAGE_PROBE_TIMEOUT_MS).toBe(180_000); // 61d33af9: 55 s → 180 s
    mockedPost.mockRejectedValueOnce(httpError(401, { code: 'InvalidApiKey', message: 'bad key sk-dash-secret' }));
    const bad = await probeImageGenerate('qwen-image-3.0');
    expect(bad.ok).toBe(false);
    expect(bad.image).toBeUndefined();
    expect(bad.detail).toContain('HTTP 401');
    expect(bad.detail).not.toContain('sk-dash-secret');
    // A keyless pinned built-in is an unconfigured verdict naming the variable.
    setEnv({});
    const keyless = await probeImageGenerate('glm-image');
    expect(keyless.ok).toBe(false);
    expect(keyless.detail).toContain('glm-image needs ZAI_API_KEY');
  });

  it('F1 (61d33af9 review): a custom image leg\'s per-request timeout DERIVES from the probe budget on the probe path — an env-raised budget reaches the leg; a chain generate keeps the 120 s plan budget', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    // b64_json answers directly — no URL download leg needed.
    const b64 = { data: { created: 1, data: [{ b64_json: png(512, 512).toString('base64') }] } };
    // The PROBE path: the leg timeout is max(120 s, the probe budget) = 180 s.
    // The deadline clamp (review 2026-09-24) shaves setup-elapsed ms off every
    // attempt (deadline = entry + budget; timeout = budget - elapsed), so the
    // exact equality the 61d33af9 lane used is racy under a loaded worker —
    // bound it instead: the budget reached the leg, minus at most 2 s of shave.
    mockedPost.mockResolvedValueOnce(b64);
    await probeImageGenerate('my-comfy:sdxl');
    expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(180_000 - 2_000);
    expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(180_000);
    // A normal (chain) generate keeps the 120 s plan budget (review 2026-09-24).
    mockedPost.mockClear();
    mockedPost.mockResolvedValueOnce(b64);
    await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(mockedPost.mock.calls[0][2].timeout).toBe(120_000);
    // An env-raised budget (clamp ceiling 300 s) actually reaches the leg —
    // same clamp-shave bound as above (the gate saw 299999 under a loaded worker).
    process.env.IMAGE_PROBE_TIMEOUT_MS = '300000';
    try {
      mockedPost.mockClear();
      mockedPost.mockResolvedValueOnce(b64);
      await probeImageGenerate('my-comfy:sdxl');
      expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(300_000 - 2_000);
      expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(300_000);
    } finally {
      delete process.env.IMAGE_PROBE_TIMEOUT_MS;
    }
  });

  it('nothing servable → ImageGenerationError unconfigured naming the seat page + env vars, zero requests; a seat-config read failure is fail-open', async () => {
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect(err.code).toBe('unconfigured');
    expect(err.message).toMatch(/Image generator seat.*Model roles.*DASHSCOPE_API_KEY \/ ZAI_API_KEY/);
    expect(err.message).toContain('qwen-image-3.0 needs DASHSCOPE_API_KEY');
    expect(mockedPost).not.toHaveBeenCalled();
    expect(imageUnconfiguredMessage()).toContain('Image generator seat');
    // Config read failure: the built-in default still serves.
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockRejectedValue(new Error('db down'));
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png() });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('qwen-image-3.0');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('seat config unreadable'));
  });

  it('the total time budget is honoured: a timed-out last leg reports code timeout', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockRejectedValueOnce(Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }));
    mockedPost.mockRejectedValueOnce(Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }));
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('last leg z-image-turbo via dashscope');
  });

  it('no logger line ever carries an API key (a 401 body echoing the Z.AI id.secret key, and the DashScope key)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash-secret-value', ZAI_API_KEY: ZAI_KEY });
    mockedPost.mockRejectedValueOnce(httpError(401, { code: 'InvalidApiKey', message: `Authorization: Bearer sk-dash-secret-value rejected` }));
    mockedPost.mockRejectedValueOnce(httpError(401, { code: 'InvalidApiKey', message: 'rejected sk-dash-secret-value' }));
    mockedPost.mockRejectedValueOnce(httpError(401, { error: { code: '1000', message: `key ${ZAI_KEY} invalid` } }));
    mockedPost.mockRejectedValueOnce(httpError(401, { error: { code: '1000', message: `secret ${ZAI_KEY.split('.')[1]} invalid` } }));
    const err = await generateImage({ prompt: 'x' }).catch(e => e);
    expect(err.code).toBe('provider');
    const lines = [...(logger.warn as jest.Mock).mock.calls, ...(logger.error as jest.Mock).mock.calls, ...(logger.info as jest.Mock).mock.calls]
      .map(c => c.map(String).join(' '));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of [...lines, err.message]) {
      expect(line).not.toContain('sk-dash-secret-value');
      expect(line).not.toContain(ZAI_KEY);
      expect(line).not.toContain(ZAI_KEY.split('.')[1]);
    }
    expect(lines.some(l => l.includes('HTTP 401'))).toBe(true);
  });
});

describe('review 2026-09-24 — edit budget, edit fallbacks, deadline clamps', () => {
  it('IMAGE_EDIT_FALLBACK_CHAIN names only edit-capable DashScope built-ins (same key as the default)', () => {
    expect(IMAGE_EDIT_FALLBACK_CHAIN.length).toBeGreaterThan(0);
    for (const id of IMAGE_EDIT_FALLBACK_CHAIN) {
      expect(IMAGE_BUILT_INS[id]).toMatchObject({ provider: 'dashscope', envKey: 'DASHSCOPE_API_KEY', edits: true });
    }
  });

  it('with a reference and no pinned spec, keyed edit-capable built-ins join as fallback legs: a 429 on qwen-image-3.0 → qwen-image-2.0 serves the edit natively; text-only legs never join', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    const ref = png(64, 64);
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling.RateQuota' })); // qwen-image-3.0 (RPM 20)
    mockedPost.mockResolvedValueOnce(dashscopeOk());                                     // qwen-image-2.0
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'Make the sky purple', reference: { bytes: ref, mimeType: 'image/png' } });
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['qwen-image-3.0', 'qwen-image-2.0']);
    expect(img).toMatchObject({ model: 'qwen-image-2.0', provider: 'dashscope', referenceMode: 'native', editLegSource: 'fallback' });
    // The fallback leg carries the reference too (an edit, not a fresh generation).
    expect(mockedPost.mock.calls[1][1].input.messages[0].content[0]).toEqual({ image: `data:image/png;base64,${ref.toString('base64')}` });
    expect(mockedPost.mock.calls.every(c => c[0] === DASHSCOPE_URL)).toBe(true); // never Z.AI
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('a pinned spec never gains edit fallbacks (the admin probe tests ONE leg)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling.RateQuota' }));
    const err = await generateImage({ prompt: 'x', spec: 'qwen-image-3.0', reference: { bytes: png(), mimeType: 'image/png' } }).catch(e => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect(err.code).toBe('provider');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('every attempt is clamped to the deadline and a 5xx retry is skipped when the budget is nearly spent (the 55 s admin probe cannot overrun)', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    let now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let firstTimeout = 0;
      mockedPost.mockImplementationOnce(async (_url: string, _body: any, opts: any) => {
        firstTimeout = opts.timeout;
        now += 52_000; // the provider held the socket almost the whole budget
        throw httpError(500, { error: { code: '1234', message: 'server' } });
      });
      const err = await generateImage({ prompt: 'x', spec: 'glm-image', probe: true, timeoutMs: 55_000 }).catch(e => e);
      // glm-image's own timeout is 150 s; the attempt got the probe budget instead.
      expect(firstTimeout).toBe(55_000);
      // retries:1 — but only 3 s of budget remain, so no second paid attempt.
      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(err.code).toBe('provider');
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('no retry'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('the URL download shares the deadline (clamped, never the flat 60 s)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    let now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockedPost.mockImplementationOnce(async () => { now += 50_000; return dashscopeOk(); });
      let getTimeout = 0;
      mockedGet.mockImplementationOnce(async (_url: string, opts: any) => { getTimeout = opts.timeout; return { data: png(512, 512) }; });
      const img = await generateImage({ prompt: 'x', spec: 'qwen-image-3.0', probe: true, timeoutMs: 55_000 });
      expect(img.model).toBe('qwen-image-3.0');
      expect(getTimeout).toBe(5_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('a short Retry-After wait is skipped when it would leave less than the minimum leg budget — the next leg serves instead', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    let now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockedPost.mockImplementationOnce(async () => { now += 2_000; throw httpError(429, { code: 'Throttling' }, { 'retry-after': '2' }); });
      mockedPost.mockResolvedValueOnce(dashscopeOk());
      mockedGet.mockResolvedValueOnce({ data: png() });
      const img = await generateImage({ prompt: 'x', timeoutMs: 8_000 });
      expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['qwen-image-3.0', 'z-image-turbo']);
      expect(img.model).toBe('z-image-turbo');
      expect(mockWarn).not.toHaveBeenCalledWith(expect.stringContaining('waiting'));
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('WI-P 2026-09-25 — implicit same-key edit legs when the seated chain has no edit-capable leg', () => {
  const ref = png(64, 64);
  const reference = { bytes: ref, mimeType: 'image/png', name: 'boat.png' };

  it('a z-image-turbo head (text only) + a servable DASHSCOPE key: the reference is EDITED natively on qwen-image-2.0, never described, editLegSource fallback', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'z-image-turbo' });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'Make the boat blue', reference });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockedPost.mock.calls[0];
    expect(url).toBe(DASHSCOPE_URL);
    expect(body.model).toBe('qwen-image-2.0'); // IMAGE_EDIT_FALLBACK_CHAIN order: the RPM-120 leg first
    expect(body.input.messages[0].content).toEqual([
      { image: `data:image/png;base64,${ref.toString('base64')}` },
      { text: 'Make the boat blue' },
    ]);
    expect(img).toMatchObject({ model: 'qwen-image-2.0', spec: 'qwen-image-2.0', provider: 'dashscope', referenceMode: 'native', editLegSource: 'fallback' });
    expect(mockDescribe).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('the seat chain has no edit-capable leg — the reference runs on the same-key edit legs qwen-image-2.0, wan2.7-image, qwen-image-3.0'));
  });

  it('the implicit legs form a full edit chain: a 429 on qwen-image-2.0 → wan2.7-image serves; a text-only head is never posted a reference', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling.RateQuota' })); // qwen-image-2.0
    mockedPost.mockResolvedValueOnce(dashscopeOk());                                     // wan2.7-image
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'x', reference });
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['qwen-image-2.0', 'wan2.7-image']);
    expect(mockedPost.mock.calls.every(c => c[0] === DASHSCOPE_URL)).toBe(true); // glm-image (Z.AI) never sees the reference
    expect(img).toMatchObject({ model: 'wan2.7-image', referenceMode: 'native', editLegSource: 'fallback' });
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('a pinned spec never gains implicit edit legs: a pinned text-only leg describes, a pinned edit leg stamps editLegSource seat', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockDescribe.mockResolvedValue('A boat.');
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(512, 512) });
    const described = await generateImage({ prompt: 'x', spec: 'z-image-turbo', probe: true, reference });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][1].model).toBe('z-image-turbo');
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(described).toMatchObject({ referenceMode: 'described' });
    expect(described.editLegSource).toBeUndefined();
    expect(mockGetModelRoleOverrides).not.toHaveBeenCalled();
    mockedPost.mockClear(); mockDescribe.mockClear();
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(512, 512) });
    const native = await generateImage({ prompt: 'x', spec: 'qwen-image-3.0', probe: true, reference });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(native).toMatchObject({ model: 'qwen-image-3.0', referenceMode: 'native', editLegSource: 'seat' });
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('without DASHSCOPE_API_KEY the implicit legs are keyless: a glm-image head still describes (no request to a keyless leg, none to Z.AI with an image)', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'glm-image' });
    mockDescribe.mockResolvedValue('A boat at a pier.');
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg() });
    const img = await generateImage({ prompt: 'Make the boat blue', reference });
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][0]).toBe(ZAI_URL);
    expect(Object.keys(mockedPost.mock.calls[0][1])).toEqual(['model', 'prompt', 'size', 'n', 'response_format']);
    expect(img).toMatchObject({ model: 'glm-image', referenceMode: 'described' });
    expect(img.editLegSource).toBeUndefined();
    expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('no edit-capable leg'));
  });
});

/* 04c8ffd1 (2026-10-23): slow local image backends (Qwen-Image behind LiteLLM,
 * 5-10 min/generation) hard-died at the 120 s custom-leg cap mid-generation.
 * The leg timeout now takes (in precedence order) the registry entry's
 * imageTimeoutMs (clamped 30 s–720 s AT SAVE by model-endpoints.service
 * validateModels — the RUN path trusts the stored value) → the
 * IMAGE_CUSTOM_TIMEOUT_MS env (clamped 120 s–720 s) → the 120 s default; and
 * the whole-call budget scales with the seated custom leg (only when RAISED
 * above the 120 s floor — review B3) so a raised cap is
 * not strangled by the old flat 240 s. The clamp-shave bound idiom is the F1
 * one: the deadline clamp shaves setup-elapsed ms off every attempt, so a
 * raised budget is asserted as a RANGE [budget - 2 s, budget]. */
describe('04c8ffd1 — per-entry / env custom-leg timeout + call-budget scaling', () => {
  // b64_json answers directly — no URL download leg needed (the F1 idiom).
  const b64 = { data: { created: 1, data: [{ b64_json: png(512, 512).toString('base64') }] } };

  it('a per-entry imageTimeoutMs (already clamped at save) reaches the axios leg on a chain generate', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 480_000 });
    mockedPost.mockResolvedValueOnce(b64);
    await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(mockedPost.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/images/generations`);
    expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(480_000 - 2_000);
    expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(480_000);
  });

  it('with NO per-entry value, the IMAGE_CUSTOM_TIMEOUT_MS env is the fallback chain timeout (clamped to the 720 s ceiling)', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    process.env.IMAGE_CUSTOM_TIMEOUT_MS = '300000';
    try {
      mockedPost.mockResolvedValueOnce(b64);
      await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
      expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(300_000 - 2_000);
      expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(300_000);
    } finally {
      delete process.env.IMAGE_CUSTOM_TIMEOUT_MS;
    }
    // Above the 720 s clamp ceiling → clamped down (imageCustomTimeoutMs).
    process.env.IMAGE_CUSTOM_TIMEOUT_MS = '9000000';
    try {
      mockedPost.mockClear();
      mockedPost.mockResolvedValueOnce(b64);
      await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
      expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(720_000 - 2_000);
      expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(720_000);
    } finally {
      delete process.env.IMAGE_CUSTOM_TIMEOUT_MS;
    }
  });

  it('a per-entry value WINS over the env: both set (480 s entry / 300 s env) → the entry timeout', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 480_000 });
    process.env.IMAGE_CUSTOM_TIMEOUT_MS = '300000';
    try {
      mockedPost.mockResolvedValueOnce(b64);
      await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
      expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(480_000 - 2_000);
      expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(480_000);
    } finally {
      delete process.env.IMAGE_CUSTOM_TIMEOUT_MS;
    }
  });

  it('a stored per-entry value at the save clamp ceiling (720 s) reaches the leg unchanged', async () => {
    setEnv({});
    // resolveRegistryModel clamps at SAVE; the run path trusts the stored value,
    // so a 720_000 entry is what a 9_000_000 admin input becomes.
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 720_000 });
    mockedPost.mockResolvedValueOnce(b64);
    await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(720_000 - 2_000);
    expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(720_000);
  });

  it('probe path: the per-entry value raises the leg above the 180 s probe budget (max(chain, probe) — the chain is no longer the floor)', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 600_000 });
    mockedPost.mockResolvedValueOnce(b64);
    await probeImageGenerate('my-comfy:sdxl');
    // leg timeout = max(600_000, 180_000 probe budget) = 600_000; the budget the
    // probe passes (180 s explicit) is lifted by the leg's need → 660 s, so the
    // shave bound stays comfortable.
    expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(600_000 - 2_000);
    expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(600_000);
  });

  it('imageCallBudgetMs is pure and byte-identical on the no-override path; scales ONLY with a custom leg RAISED above the 120 s floor; caps at 780 s; an explicit budget stays the authority at stock timeouts (review B3)', () => {
    // No overrides: exactly the pre-04c8ffd1 flat budget.
    expect(imageCallBudgetMs(undefined, 120_000)).toBe(240_000);
    expect(imageCallBudgetMs(undefined, 0)).toBe(240_000);
    // Review B3: the STOCK 120 s custom leg never lifts a budget — an explicit
    // budget is the authority (IMAGE_PROBE_TIMEOUT_DISABLED=1's 55 s restore and
    // the probe's 180 s both hold on custom-leg probes, byte-identical to
    // pre-04c8ffd1).
    expect(imageCallBudgetMs(55_000, 120_000)).toBe(55_000);
    expect(imageCallBudgetMs(180_000, 120_000)).toBe(180_000);
    // Per-entry / env-raised legs: budget = leg + 60 s download allowance.
    expect(imageCallBudgetMs(undefined, 720_000)).toBe(780_000);
    expect(imageCallBudgetMs(undefined, 300_000)).toBe(360_000);
    // An explicit budget is kept unless a raised custom leg needs more.
    expect(imageCallBudgetMs(180_000, 480_000)).toBe(540_000);
    expect(imageCallBudgetMs(55_000, 0)).toBe(55_000);   // built-ins never scale it
    expect(imageCallBudgetMs(8_000, 0)).toBe(8_000);
    // The cap: a 900 s leg (impossible via clamps, belt-and-braces) → 780 s —
    // real margin under the agent tool's 15-min hard race for the setup and
    // storage that run OUTSIDE this deadline (review B2).
    expect(imageCallBudgetMs(180_000, 900_000)).toBe(780_000);
    expect(imageCallBudgetMs(undefined, 900_000)).toBe(780_000);
    expect(IMAGE_CALL_BUDGET_MAX_MS).toBeLessThan(900_000);
    // The no-override chain value itself is untouched (the F1 default pin).
    expect(IMAGE_CUSTOM_TIMEOUT_MAX_MS).toBe(720_000);
    expect(imageCustomTimeoutMs()).toBe(120_000); // no env set in this suite's baseline
  });

  it('the F1 pins hold unchanged: a chain generate keeps the 120 s plan budget with no overrides', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockResolvedValueOnce(b64);
    await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(mockedPost.mock.calls[0][2].timeout).toBe(120_000);
  });
});

/* 99b5545d (2026-10-24): a slow OpenAI-shaped image backend (local
 * Qwen-Image-2.1-class, 5-10 min/image) may answer the submit with 202 + a job
 * id instead of holding the HTTP request open — the async-job shape the owner
 * endorsed after the 04c8ffd1 timeout knob proved insufficient (the ~100 s
 * Cloudflare proxy cut kills real-size generations no matter how high
 * imageTimeoutMs is raised). Digby's leg then POLLS the job's status endpoint
 * until done / failed / the whole-call budget (the polling ceiling) runs out;
 * every poll is a fresh short request so no request hangs. The sync 200 path
 * is byte-identical to before. Fake timers drive the 2 s poll interval without
 * real sleeps. */
describe('99b5545d — async 202 + job-id polling mode (slow image providers)', () => {
  const b64 = { data: { created: 1, data: [{ b64_json: png(512, 512).toString('base64') }] } };
  /** A 202 submit answer carrying a job id (OpenAI images-job flavour). */
  const accepted = (jobId = 'job_abc123') => ({ status: 202, data: { id: jobId, object: 'image.generation.job', status: 'in_progress' } });
  /** A status-GET answer in the OpenAI images-job flavour. */
  const status = (state: string, extra: Record<string, unknown> = {}) => ({ data: { id: 'job_abc123', status: state, ...extra } });
  const running = () => status('in_progress');
  const done = () => status('completed', { output: [{ b64_json: png(512, 512).toString('base64') }] });

  beforeEach(() => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
  });

  afterEach(() => { jest.useRealTimers(); });

  it('a 202 + job id submit → poll {base}/images/jobs/{id} every 2 s until done — the image delivers as a normal chat file', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(done());
    // three polls → two interval waits elapsed (2 s + 2 s) — the clock delta
    // (fake timers mock Date) pins the cadence. Review f246 nit 14: asserting
    // an absolute Date.now() >= 4_000 was vacuous — the mocked clock starts
    // at the real 2026 epoch; assert the DELTA from a captured base.
    const startedAt = Date.now();
    const promise = generateImage({ prompt: 'a big boat', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);   // first poll fires
    await jest.advanceTimersByTimeAsync(2_000);   // second poll still running
    const img = await promise;
    // submit + 3 polls, each a fresh short request
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(mockedGet.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/images/jobs/job_abc123`);
    expect(mockedGet.mock.calls[0][1].timeout).toBeLessThanOrEqual(30_000);
    expect(img.mimeType).toBe('image/png');
    expect(img.bytes.length).toBeGreaterThan(0);
    expect(img.width).toBe(512);
    expect(img.model).toBe('sdxl');
    expect(img.provider).toBe('custom');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
  });

  it('a body status_url overrides the derived job-status URL, relative or absolute', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: 'j1', status_url: '/v1/queue/j1/status' } });
    mockedGet.mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mockedGet.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/queue/j1/status`);
    // absolute wins over relative
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: 'j2', status_url: 'https://shim.example/j2' } });
    mockedGet.mockClear().mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(mockedGet.mock.calls[0][0]).toBe('https://shim.example/j2');
  });

  it('the standard HTTP Location HEADER alone (no body job id) is the poll target — absolute or relative to the submit base', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce({ status: 202, headers: { location: 'https://shim.example/queue/j3' }, data: {} });
    mockedGet.mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mockedGet.mock.calls[0][0]).toBe('https://shim.example/queue/j3');
    // relative Location resolves against the submit base
    mockedPost.mockClear().mockResolvedValueOnce({ status: 202, headers: { location: '/v1/jobs/j4' }, data: {} });
    mockedGet.mockClear().mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const p2 = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await p2;
    expect(mockedGet.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/jobs/j4`);
  });

  it('the FINAL poll answering raw image bytes (image/png content-type) IS the delivery — no JSON envelope', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce({ data: png(64, 32), headers: { 'content-type': 'image/png' } });
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    const img = await promise;
    expect(img.mimeType).toBe('image/png');
    expect(img.width).toBe(64);
    expect(img.height).toBe(32);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('a job that reports failed → provider error carrying the job\'s own error message; no image bytes accepted', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet.mockResolvedValueOnce(status('failed', { error: { message: 'GPU OOM — the node died' } }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    // Attach the rejection handler BEFORE advancing the clock — otherwise the
    // settled rejection sits unhandled while the timers run and jest fails the
    // test on the unhandled rejection, not the assertion.
    const assertion = expect(promise).rejects.toThrow(/async job job_abc123 failed — GPU OOM — the node died/);
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('the polling budget (the whole-call deadline) is the ceiling: budget exhausted while running → ImageGenerationError code timeout', async () => {
    jest.useFakeTimers();
    // Stock REG_IMAGE (no imageTimeoutMs): budget = imageCallBudgetMs(undefined, 120_000) = 240 s.
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet.mockImplementation(async () => status('in_progress'));   // never finishes
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    // Run the poll loop past the 240 s deadline (default: leg 120 s + 60 s download → 240 s).
    let rejected: any = null;
    promise.catch((e: any) => { rejected = e; });
    for (let i = 0; i < 140; i++) {
      await jest.advanceTimersByTimeAsync(2_000);
      if (rejected) break;
    }
    expect(rejected).toBeInstanceOf(ImageGenerationError);
    expect(rejected.code).toBe('timeout');
    expect(String(rejected.message)).toMatch(/timed out/);
  });

  it('a raised budget (imageTimeoutMs 480 s) extends the polling ceiling — still running past the old 240 s ceiling, delivers at ~300 s', async () => {
    jest.useFakeTimers();
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 480_000 });
    mockedPost.mockResolvedValueOnce(accepted());
    // Budget = 480 s leg + 60 s download = 540 s. Complete on poll #150
    // (t ≈ 298 s) — past the flat 240 s ceiling that killed the old sync path.
    let polls = 0;
    mockedGet.mockImplementation(async () => {
      polls++;
      return polls < 150 ? status('in_progress') : status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] });
    });
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    let settled: any = null;
    promise.then((v: any) => { settled = v; }, (e: any) => { settled = e; });
    // Never await the pending promise inside the loop (that deadlocks the fake
    // clock) — poll the settled flag instead.
    for (let i = 0; i < 160 && settled == null; i++) await jest.advanceTimersByTimeAsync(2_000);
    expect(settled).not.toBeInstanceOf(Error);
    expect(settled.mimeType).toBe('image/png');
    expect(polls).toBeGreaterThanOrEqual(150);
  }, 15_000);

  it('sync path unchanged: a 200 b64 answer never polls (no status GET), byte-identical to pre-99b5545d', async () => {
    mockedPost.mockResolvedValueOnce(b64);
    const img = await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(img.mimeType).toBe('image/png');
    expect(mockedGet).toHaveBeenCalledTimes(0);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/images/generations`);
  });

  it('a 202 with NO usable job id → provider error naming the shape (never the sync "returned no image" lie, never polling)', async () => {
    mockedPost.mockResolvedValueOnce({ status: 202, data: { object: 'image.generation.job', status: 'queued' } });
    await expect(generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' })).rejects.toThrow(/202 with no job id/);
    expect(mockedGet).toHaveBeenCalledTimes(0);
  });

  it('a 202 carrying the image INLINE (no job id) delivers like a sync answer — the pre-99b5545d behavior (f246 finding 8)', async () => {
    mockedPost.mockResolvedValueOnce({ status: 202, data: { created: 1, data: [{ b64_json: png(8, 8).toString('base64') }] } });
    const img = await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(img.mimeType).toBe('image/png');
    expect(img.width).toBe(8);
    expect(mockedGet).toHaveBeenCalledTimes(0);
  });

  it('a bare, uncorroborated `id` on a 202 is NOT a job id — no polling a wrong route (f246 finding 11)', async () => {
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: 'evt_20261024_0001', object: 'event.received' } });
    // `object:'event.received'` does not corroborate a JOB id; no Location, no
    // inline image → provider shape error, never a poll.
    await expect(generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' })).rejects.toThrow(/202 with no job id/);
    expect(mockedGet).toHaveBeenCalledTimes(0);
  });

  it('a zai leg answering 202 is NOT the async shape — the provider guard keeps the async route custom-only (a built-in never polls)', async () => {
    setEnv({ ZAI_API_KEY: ZAI_KEY });
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: 'job_zai' } });
    const promise = generateImage({ prompt: 'x', spec: 'glm-image' });
    await expect(promise).rejects.toThrow();   // falls into the sync no-image error path
    expect(mockedGet).toHaveBeenCalledTimes(0);
  });

  it('transient status-poll errors (network/5xx) are tolerated up to IMAGE_ASYNC_POLL_MAX_ERRORS then give up with a provider error', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    // 6 CONSECUTIVE rejections (one above the 5-tolerance) — the seventh poll
    // would only run if the loop wrongly continued past the give-up point.
    mockedGet
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }))
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }))
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }))
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }))
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }))
      .mockRejectedValueOnce(httpError(503, { error: 'overloaded' }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    let rejected: any = null;
    promise.catch((e: any) => { rejected = e; });
    for (let i = 0; i < 30 && rejected == null; i++) await jest.advanceTimersByTimeAsync(2_000);
    expect(rejected).toBeInstanceOf(ImageGenerationError);
    expect(mockedGet).toHaveBeenCalledTimes(6);
    expect(String(rejected.message)).toMatch(/async job job_abc123/);
    expect(String(rejected.message)).toMatch(/5\+ times in a row/);
  });

  it('shape drift guards: poll interval default and the derived status URL contract', async () => {
    const mod = await import('./image-generate');
    expect(mod.IMAGE_ASYNC_POLL_INTERVAL_MS).toBe(2_000);
  });

  // ── Review f246 (adversarial, 2026-10-24) — hardening pins ──────────────────
  it('f246-6: a status body carrying NO recognizable job state bails after 3 consecutive unparseable polls with a provider error naming the body — never a silent spin to the budget timeout', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    // Three consecutive HTML error pages (non-JSON, no job state).
    mockedGet
      .mockResolvedValueOnce({ data: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } })
      .mockResolvedValueOnce({ data: '', headers: {} })
      .mockResolvedValueOnce({ data: 'not json at all', headers: { 'content-type': 'text/plain' } });
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    let rejected: any = null;
    promise.catch((e: any) => { rejected = e; });
    for (let i = 0; i < 10 && rejected == null; i++) await jest.advanceTimersByTimeAsync(2_000);
    expect(rejected).toBeInstanceOf(ImageGenerationError);
    expect(rejected.code).toBe('provider');
    expect(String(rejected.message)).toMatch(/no recognizable job state/);
    // the error names the LAST body seen (the third), proving the counter ran
    expect(String(rejected.message)).toMatch(/not json at all/);
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('f246-6: raw image bytes the SNIFFER recognizes deliver even when the content-type lies or is missing', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce({ data: png(64, 32), headers: {} })   // no content-type at all
      .mockResolvedValueOnce({ data: png(64, 32), headers: { 'content-type': 'application/octet-stream' } });
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    const img = await promise;
    expect(img.mimeType).toBe('image/png');
    expect(img.width).toBe(64);
    expect(img.height).toBe(32);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('f246-6: a content-type CLAIMING image/png over NON-image bytes never delivers garbage — the body is unparseable and bails', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce({ data: Buffer.from('this is not an image, sorry'), headers: { 'content-type': 'image/png' } })
      .mockResolvedValueOnce({ data: Buffer.from('still not an image'), headers: { 'content-type': 'image/png' } })
      .mockResolvedValueOnce({ data: Buffer.from('never an image'), headers: { 'content-type': 'image/png' } });
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    let rejected: any = null;
    promise.catch((e: any) => { rejected = e; });
    for (let i = 0; i < 10 && rejected == null; i++) await jest.advanceTimersByTimeAsync(2_000);
    expect(rejected).toBeInstanceOf(ImageGenerationError);
    expect(rejected.code).toBe('provider');
    expect(String(rejected.message)).toMatch(/no recognizable job state/);
  });

  it('f246-7: the poll sends Authorization ONLY to the submit endpoint\'s own origin — a cross-origin explicit status URL is polled unauthenticated', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: 'jx', status_url: 'https://shim.example/jx' } });
    mockedGet.mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mockedGet.mock.calls[0][0]).toBe('https://shim.example/jx');
    expect(mockedGet.mock.calls[0][1].headers.Authorization).toBeUndefined();
    // same-origin derived URL still carries the bearer
    mockedPost.mockResolvedValueOnce(accepted());
    mockedGet.mockClear().mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const p2 = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await p2;
    expect(mockedGet.mock.calls[0][0]).toBe(`${REG_IMAGE.baseUrl}/images/jobs/job_abc123`);
    expect(mockedGet.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-registry-secret');
  });

  it('f246-9: a slash-less relative Location header resolves against the submit URL — no percent-encoded bogus route', async () => {
    jest.useFakeTimers();
    mockedPost.mockResolvedValueOnce({ status: 202, headers: { location: 'v1/jobs/j9' }, data: {} });
    mockedGet.mockResolvedValueOnce(status('completed', { output: [{ b64_json: png(8, 8).toString('base64') }] }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    await jest.advanceTimersByTimeAsync(2_000);
    await promise;
    // RFC 7231: a relative reference without a leading slash resolves against
    // the submit URL, dropping its last segment — http://10.0.0.5:8188/v1/images/generations
    // + 'v1/jobs/j9' → http://10.0.0.5:8188/v1/images/v1/jobs/j9. That is the
    // RFC-correct reading (NOT the pre-fix percent-encoded {base}/images/jobs/v1%2Fjobs%2Fj9).
    expect(mockedGet.mock.calls[0][0]).toBe('http://10.0.0.5:8188/v1/images/v1/jobs/j9');
  });

  it('f246-10: a job id that is a SIGNED URL is never printed raw in any error (origin+pathname only)', async () => {
    jest.useFakeTimers();
    const signed = 'https://shim.example/jobs/j7?X-Amz-Signature=deadbeefcafebabe&X-Amz-Credential=SECRET';
    mockedPost.mockResolvedValueOnce({ status: 202, data: { id: signed, object: 'image.generation.job', status: 'queued' } });
    mockedGet.mockRejectedValueOnce(httpError(404, { error: 'no such job' }));
    const promise = generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    const assertion = expect(promise).rejects.toThrow(/async job https:\/\/shim\.example\/jobs\/j7/);
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    // the thrown message and every logger line name the signed URL's shape, never its query
    expect(mockWarn.mock.calls.some((c: any[]) => JSON.stringify(c).includes('X-Amz-Signature'))).toBe(false);
    expect(mockInfo.mock.calls.some((c: any[]) => JSON.stringify(c).includes('X-Amz-Signature'))).toBe(false);
    expect(mockInfo.mock.calls.some((c: any[]) => JSON.stringify(c).includes('https://shim.example/jobs/j7'))).toBe(true);
  });
});

/* 09a03aef (2026-10-24): a seated custom image model that TIMES OUT on the
 * chain path fell to a built-in with NO admin-visible signal — the seat read
 * servable/0-failures, the admin Test stayed green (it probes 512×512 under
 * the probe budget, a size/budget combination real traffic never uses), and
 * 100% of chat generates served a model the owner never chose. The fix: (A)
 * the chain result STAMPS the substitution (substitutedFor + substitutionReason
 * on GeneratedImage; the generate_image tool result and the image_generation
 * loop_metric carry it); (B) probeImageGenerate appends a chain-
 * representativeness warning when the measured 512² latency × the pixel scale
 * of a chain size exceeds the leg's real chain timeout; (C) the seat save
 * (model-roles.service assertAssignable) warns the same way from the entry's
 * last Detect-capabilities image_generation latency. */
describe('09a03aef — no silent model substitution on the image chain', () => {
  // b64_json answers directly — no URL download leg needed (the 04c8ffd1 idiom).
  const b64 = (w = 512, h = 512) => ({ data: { created: 1, data: [{ b64_json: png(w, h).toString('base64') }] } });

  it('A — a seated custom leg that TIMES OUT falls to a built-in AND the result names the substitution: substitutedFor = the seated spec, substitutionReason timeout (the warn line alone was the whole pre-fix signal)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE); // no imageTimeoutMs → stock 120 s chain timeout
    // The seated custom leg times out (ECONNABORTED — exactly the incident:
    // ~220 s real latency > 120 s stock chain timeout).
    mockedPost.mockImplementationOnce(() => {
      const e: any = new Error('timeout of 120000ms exceeded');
      e.code = 'ECONNABORTED';
      return Promise.reject(e);
    });
    // The built-in z-image-turbo serves (864×1152 portrait — the incident's
    // DashScope size grid).
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(864, 1152) });
    const img = await generateImage({ prompt: 'a quiet harbour at dawn', aspect: 'portrait' });
    expect(img.model).toBe('z-image-turbo');
    expect(img.spec).toBe('z-image-turbo');
    // THE FIX: the substitution is stamped, not silent.
    expect(img.substitutedFor).toBe('my-comfy:sdxl');
    expect(img.substitutionReason).toBe('timeout');
    // The chain really ran the seated leg first (the timeout was real, not a skip).
    expect(mockedPost.mock.calls.map(c => c[1].model)).toEqual(['sdxl', 'z-image-turbo']);
  });

  it('A — a seated custom leg with a PROVIDER error (401) falls to a built-in with substitutionReason provider', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockRejectedValueOnce(httpError(401, { error: { message: 'bad key' } }));
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(512, 512) });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('z-image-turbo');
    expect(img.substitutedFor).toBe('my-comfy:sdxl');
    expect(img.substitutionReason).toBe('provider');
  });

  it('A (review MED) — the reason is the SEATED leg\'s OWN failure class, never a later leg\'s: the seated custom leg TIMES OUT, the next built-in 401s, a later built-in serves ⇒ substitutionReason timeout (the old last-error reading relabeled it provider)', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash', ZAI_API_KEY: ZAI_KEY });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    // The seated custom leg times out (the incident).
    mockedPost.mockImplementationOnce(() => {
      const e: any = new Error('timeout of 120000ms exceeded');
      e.code = 'ECONNABORTED';
      return Promise.reject(e);
    });
    // The NEXT chain leg (z-image-turbo) fails with a PROVIDER error — under
    // the pre-review code the stamp read this error, relabeling the seated
    // model's timeout as 'provider'.
    mockedPost.mockRejectedValueOnce(httpError(401, { error: { message: 'bad key' } }));
    // glm-image (Z.AI, third chain leg) serves.
    mockedPost.mockResolvedValueOnce(zaiOk());
    mockedGet.mockResolvedValueOnce({ data: jpeg(512, 512) });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('glm-image');
    expect(img.substitutedFor).toBe('my-comfy:sdxl');
    expect(img.substitutionReason).toBe('timeout');
  });

  it('A (review MED) — a seat spec that never RESOLVED (endpoint deleted/disabled/renamed) stamps unavailable, never the serving run-leg\'s head: substitutedFor = the SEAT spec even though it is in no run list', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'ghost:model' });
    mockResolveRegistryModel.mockResolvedValue(null);
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(864, 1152) });
    const img = await generateImage({ prompt: 'x' });
    expect(img.model).toBe('z-image-turbo');
    // Under runLegs[0] semantics this named z-image-turbo — the SERVING leg's
    // own head — i.e. no signal at all. The seat's spec is the truth.
    expect(img.substitutedFor).toBe('ghost:model');
    expect(img.substitutionReason).toBe('unavailable');
    expect(describeImageSubstitution(img)).toContain('the seated model ghost:model was unavailable');
  });

  it('A (review MED) — an EDIT whose first edit-fallback leg fails and a later one serves stamps NO substitution (the seat spec never carried the request — editLegSource already says it); under runLegs[0] semantics this mislabeled the first edit-fallback leg as "the seated model"', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'z-image-turbo' });
    mockedPost.mockRejectedValueOnce(httpError(429, { code: 'Throttling.RateQuota' })); // qwen-image-2.0 (edit fallback)
    mockedPost.mockResolvedValueOnce(dashscopeOk());                                   // wan2.7-image serves
    mockedGet.mockResolvedValueOnce({ data: png(1024, 1024) });
    const img = await generateImage({ prompt: 'Make the boat blue', reference: { bytes: png(64, 64), mimeType: 'image/png' } });
    expect(img).toMatchObject({ model: 'wan2.7-image', referenceMode: 'native', editLegSource: 'fallback' });
    expect(img.substitutedFor).toBeUndefined();
    expect(img.substitutionReason).toBeUndefined();
  });

  it('A — NO substitution marker when the SEATED model serves (the head leg succeeds), when the seat is a BUILT-IN, or on a pinned spec probe', async () => {
    setEnv({ DASHSCOPE_API_KEY: 'sk-dash' });
    // (1) The seated custom leg itself serves.
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockResolvedValueOnce(b64());
    const served = await generateImage({ prompt: 'x' });
    expect(served.model).toBe('sdxl');
    expect(served.substitutedFor).toBeUndefined();
    expect(served.substitutionReason).toBeUndefined();
    // (2) A BUILT-IN seat: z-image-turbo serves as the head leg — a built-in
    // chain is the documented seat behaviour, and the head leg serving is not
    // a substitution anyway.
    mockedPost.mockClear();
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'z-image-turbo' });
    mockedPost.mockResolvedValueOnce(dashscopeOk());
    mockedGet.mockResolvedValueOnce({ data: png(512, 512) });
    const builtin = await generateImage({ prompt: 'x' });
    expect(builtin.model).toBe('z-image-turbo');
    expect(builtin.substitutedFor).toBeUndefined();
    // (3) A pinned spec (the admin probe): no seat chain consulted, no
    // substitution concept.
    mockedPost.mockClear();
    mockGetModelRoleOverrides.mockClear();
    mockedPost.mockResolvedValueOnce(b64());
    const pinned = await generateImage({ prompt: 'x', spec: 'my-comfy:sdxl' });
    expect(pinned.model).toBe('sdxl');
    expect(pinned.substitutedFor).toBeUndefined();
    expect(mockGetModelRoleOverrides).not.toHaveBeenCalled();
  });

  it('A — describeImageSubstitution is the one-line surface the tool result and the leaf share', () => {
    expect(describeImageSubstitution({ model: 'z-image-turbo', provider: 'dashscope', spec: 'z-image-turbo', bytes: png(), mimeType: 'image/png', latencyMs: 4_000, referenceMode: 'none', substitutedFor: 'my-comfy:sdxl', substitutionReason: 'timeout' })).toContain('served by z-image-turbo (fallback) — the seated model my-comfy:sdxl timed out');
    // No substitution → empty line (the tool result stays byte-identical).
    expect(describeImageSubstitution({ model: 'sdxl', provider: 'custom', spec: 'my-comfy:sdxl', bytes: png(), mimeType: 'image/png', latencyMs: 4_000, referenceMode: 'none' })).toBe('');
  });

  it('B — the admin Test detail WARNS when the measured 512² latency × pixel scale exceeds the chain timeout (the incident: 48.8 s @512² → ~190 s at portrait 896×1152 > the 120 s stock chain timeout)', async () => {
    setEnv({});
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE); // no imageTimeoutMs → 120 s chain timeout
    // The probe answers in 48.8 s with a 512×512 image (exactly the incident's
    // test_model_role shape).
    let now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockedPost.mockImplementationOnce(async () => { now += 48_800; return b64(512, 512); });
      const r = await probeImageGenerate('my-comfy:sdxl');
      expect(r.ok).toBe(true);
      // THE FIX: the green line carries the chain-representativeness warning.
      expect(r.detail).toContain('HEADS-UP');
      expect(r.detail).toContain('chain timeout');
      expect(r.detail).toContain('imageTimeoutMs');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('B — no warning when the scaled latency FITS the chain timeout, and a raised per-entry imageTimeoutMs absorbs the scale', async () => {
    setEnv({});
    // A fast custom leg: 4 s @512² → ~15.6 s at portrait scale, well under 120 s.
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockedPost.mockResolvedValueOnce(b64(512, 512));
    const fast = await probeImageGenerate('my-comfy:sdxl');
    expect(fast.ok).toBe(true);
    expect(fast.detail).not.toContain('HEADS-UP');
    // The incident's backend with the owner-side unblock applied: a 600 s
    // per-entry imageTimeoutMs makes the projected ~190 s fit — no warning.
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 600_000 });
    mockedPost.mockClear();
    let now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockedPost.mockImplementationOnce(async () => { now += 48_800; return b64(512, 512); });
      const raised = await probeImageGenerate('my-comfy:sdxl');
      expect(raised.ok).toBe(true);
      expect(raised.detail).not.toContain('HEADS-UP');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('B — probeSizeScale / probeChainRepresentativeness are pure: pixel scale from 512² to the CUSTOM_SIZES grid; empty verdict when it fits', () => {
    // square 1024×1024 = 4× the probe pixels; portrait 896×1152 ≈ 3.9×.
    expect(probeSizeScale('square')).toBe(4);
    expect(probeSizeScale('portrait')).toBeCloseTo((896 * 1152) / (512 * 512), 5);
    // 48.8 s scaled to portrait (~190 s) > 120 s stock chain timeout → warn.
    const verdict = probeChainRepresentativeness(48_800, 120_000, 'portrait');
    expect(verdict).toContain('512×512');
    expect(verdict).toContain('896x1152');
    expect(verdict).toContain('120 s');
    // Fits → empty (no noise on healthy seats).
    expect(probeChainRepresentativeness(4_000, 120_000, 'portrait')).toBe('');
    expect(probeChainRepresentativeness(48_800, 600_000, 'portrait')).toBe('');
  });

  it('the 04c8ffd1 budget-scaling pins hold unchanged alongside the substitution stamp (a raised per-entry timeout still reaches the axios leg)', async () => {
    setEnv({});
    mockGetModelRoleOverrides.mockResolvedValue({ image_generate: 'my-comfy:sdxl' });
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 480_000 });
    mockedPost.mockResolvedValueOnce(b64());
    const img = await generateImage({ prompt: 'x', aspect: 'portrait' });
    expect(img.model).toBe('sdxl');
    expect(img.substitutedFor).toBeUndefined();
    expect(mockedPost.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(480_000 - 2_000);
    expect(mockedPost.mock.calls[0][2].timeout).toBeLessThanOrEqual(480_000);
  });
});
