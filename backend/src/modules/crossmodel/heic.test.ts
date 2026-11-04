/**
 * HEIC/HEIF → JPEG conversion (owner report 2026-09-03): iPhones upload HEIC
 * by default; the owner's .heic screenshot of the sticky-thinking bug hit the
 * analyzer's "HEIC/HEIF images are not supported" refusal even though the
 * upload form lists HEIC as a supported format. These tests pin the fix at
 * both ingestion points:
 *   1. convertHeicToJpeg — success, decoder failure (null, never throws);
 *   2. describeImageWithVision — a HEIC input is converted and posted to the
 *      vision API (glm-5.3-flash via ZAI since 2026-09-03) as image/jpeg
 *      (previously: unconditional throw);
 *   3. the "convert first" error survives ONLY a genuine decoder failure.
 */

const mockConvert = jest.fn();
jest.mock('heic-convert', () => ({ __esModule: true, default: mockConvert }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: mockPost } }));
// image-describe resolves the Image reader SEAT (2026-09-22) through the
// model-roles service (dynamic import) — mocked: no override, no fallback, so
// the built-in glm-5.3-flash serves. The real module pulls config/env.
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
  getModelRoleOverrides: async () => ({}),
}));

import { convertHeicToJpeg, isHeicMime } from './heic';

const JPEG_OUT = Buffer.from('ffd8ffe0-jpeg-bytes');

beforeEach(() => {
  jest.clearAllMocks();
  mockConvert.mockResolvedValue(JPEG_OUT);
});

describe('isHeicMime', () => {
  it('matches heic/heif, nothing else', () => {
    expect(isHeicMime('image/heic')).toBe(true);
    expect(isHeicMime('image/heif')).toBe(true);
    expect(isHeicMime('image/jpeg')).toBe(false);
    expect(isHeicMime(undefined)).toBe(false);
  });
});

describe('convertHeicToJpeg', () => {
  it('converts via heic-convert at quality 0.92 and returns a Buffer', async () => {
    const input = Buffer.from('heic-bytes');
    const out = await convertHeicToJpeg(input);
    expect(mockConvert).toHaveBeenCalledWith({ buffer: input, format: 'JPEG', quality: 0.92 });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out?.equals(JPEG_OUT)).toBe(true);
  });

  it('returns null (never throws) when the decoder fails', async () => {
    mockConvert.mockRejectedValue(new Error('corrupt heic'));
    await expect(convertHeicToJpeg(Buffer.from('junk'))).resolves.toBeNull();
  });
});

describe('describeImageWithVision HEIC handling (owner report 2026-09-03)', () => {
  const load = () => {
    process.env.ZAI_API_KEY = 'test-key';
    // Module-const key read at import time — isolate per case.
    jest.resetModules();
    return require('./image-describe');
  };

  it('converts a HEIC buffer and posts it to vision as image/jpeg', async () => {
    const { describeImageWithVision } = load();
    mockPost.mockResolvedValue({
      data: { choices: [{ message: { content: 'a screenshot' } }] },
    });
    const text = await describeImageWithVision(Buffer.from('heic-bytes'), 'image/heic', 'shot.heic');
    expect(text).toBe('a screenshot');
    expect(mockConvert).toHaveBeenCalled();
    const payload = mockPost.mock.calls[0][1];
    expect(payload.model).toBe('glm-5.3-flash');
    const imagePart = payload.messages[0].content.find((c: any) => c.type === 'image_url');
    expect(imagePart.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('keeps the helpful "convert first" error ONLY when the decoder genuinely fails', async () => {
    mockConvert.mockRejectedValue(new Error('corrupt heic'));
    const { describeImageWithVision } = load();
    await expect(describeImageWithVision(Buffer.from('junk'), 'image/heif', 'x.heif'))
      .rejects.toThrow('HEIC/HEIF images are not supported');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('leaves non-HEIC formats untouched (no conversion call)', async () => {
    const { describeImageWithVision } = load();
    mockPost.mockResolvedValue({
      data: { choices: [{ message: { content: 'a png' } }] },
    });
    await describeImageWithVision(Buffer.from('png-bytes'), 'image/png', 'x.png');
    expect(mockConvert).not.toHaveBeenCalled();
    const payload = mockPost.mock.calls[0][1];
    const imagePart = payload.messages[0].content.find((c: any) => c.type === 'image_url');
    expect(imagePart.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
