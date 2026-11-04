/**
 * GET /api/crossmodel/generated-files/:id/inline (generate_image, 2026-09-24):
 * the image-only inline byte route the transcript's <img src> and the Files
 * thumbnails fetch. Pins: image/* serves inline with nosniff + private
 * caching; non-images (pdf/xlsx/md) 415; another user's file 404 (never
 * leaked); anonymous 401; and the download twin's behaviour is unchanged
 * (attachment disposition, verbatim stored mime, no cache header).
 * Scaffold: chat-files.test.ts (fake req/res, mocked prisma).
 */

const mockFindUnique = jest.fn();
const mockPrisma: any = { generatedFile: { findUnique: (...a: any[]) => mockFindUnique(...a) } };
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// middleware/auth's import chain is jest-unsafe; AuthRequest is a type-only import here.
jest.mock('../../middleware/auth', () => ({ AuthRequest: {} }));
// chat-files.controller pulls crossmodel.service + text-extract; only its
// pure one-liner is needed here.
jest.mock('./chat-files.controller', () => ({
  __esModule: true,
  mimeEssence: (m: string) => m.split(';', 1)[0].trim().toLowerCase(),
}));

import { inlineGeneratedFile, downloadGeneratedFile, isInlineImageMime } from './generated-files.controller';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const IMAGE_ROW = {
  id: 'f-img', userId: 'u-owner', chatId: 'c1', filename: 'image-20260924-140322-a-red-fox.png', format: 'png',
  mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), textContent: '[Generated image] …',
};
const PDF_ROW = { ...IMAGE_ROW, id: 'f-pdf', filename: 'report.pdf', format: 'pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') };

const mkReq = (over: any = {}): any => ({ params: { id: 'f-img' }, user: { id: 'u-owner' }, ...over });
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, any>,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
    setHeader: jest.fn((k: string, v: any) => { res.headers[k] = v; }),
    send: jest.fn((b: any) => { res.body = b; return res; }),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue(IMAGE_ROW);
});

describe('inline route', () => {
  it('serves an image inline: essence Content-Type, inline disposition, nosniff, private hour cache, the decoded bytes', async () => {
    const res = mkRes();
    await inlineGeneratedFile(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'f-img' } });
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Content-Length']).toBe(PNG.length);
    expect(res.headers['Content-Disposition']).toMatch(/^inline; filename="image-20260924-140322-a-red-fox\.png"; filename\*=UTF-8''/);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Cache-Control']).toBe('private, max-age=3600');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(PNG)).toBe(true);
  });

  it('normalizes a parameterized stored mime to its essence', async () => {
    mockFindUnique.mockResolvedValue({ ...IMAGE_ROW, mimeType: 'image/jpeg; charset=binary' });
    const res = mkRes();
    await inlineGeneratedFile(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
  });

  it('415s a non-image (pdf) — only images may render on the app origin from this route', async () => {
    mockFindUnique.mockResolvedValue(PDF_ROW);
    const res = mkRes();
    await inlineGeneratedFile(mkReq({ params: { id: 'f-pdf' } }), res);
    expect(res.statusCode).toBe(415);
    expect(res.body).toEqual({ error: 'Only images can be shown inline — use the download URL.' });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('415s scripting-capable SVG and other document families (xlsx, md, html)', async () => {
    for (const mimeType of ['image/svg+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/markdown', 'text/html']) {
      mockFindUnique.mockResolvedValue({ ...IMAGE_ROW, mimeType });
      const res = mkRes();
      await inlineGeneratedFile(mkReq(), res);
      expect({ mimeType, status: res.statusCode }).toEqual({ mimeType, status: 415 });
    }
    expect(isInlineImageMime('image/png')).toBe(true);
    expect(isInlineImageMime('image/webp')).toBe(true);
    expect(isInlineImageMime('image/svg+xml')).toBe(false);
    expect(isInlineImageMime('application/pdf')).toBe(false);
  });

  it("404s another user's file (same as not-found — existence never leaks)", async () => {
    const res = mkRes();
    await inlineGeneratedFile(mkReq({ user: { id: 'u-other' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });

    mockFindUnique.mockResolvedValue(null);
    const res2 = mkRes();
    await inlineGeneratedFile(mkReq(), res2);
    expect(res2.statusCode).toBe(404);
    expect(res2.body).toEqual({ error: 'File not found' });
  });

  it('401s an anonymous request (the query-token twin passes anonymous through; the handler self-checks)', async () => {
    const res = mkRes();
    await inlineGeneratedFile(mkReq({ user: undefined }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('500s (never throws) on a DB failure', async () => {
    mockFindUnique.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await inlineGeneratedFile(mkReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to serve file' });
  });
});

describe('download twin — unchanged behaviour (regression)', () => {
  it('serves any format as an attachment with the stored mime verbatim and no cache header', async () => {
    mockFindUnique.mockResolvedValue(PDF_ROW);
    const res = mkRes();
    await downloadGeneratedFile(mkReq({ params: { id: 'f-pdf' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="report\.pdf"; filename\*=UTF-8''report\.pdf$/);
    expect(res.headers['X-Content-Type-Options']).toBeUndefined();
    expect(res.headers['Cache-Control']).toBeUndefined();
    expect(res.body.toString()).toBe('%PDF-1.4');
  });

  it('still 401s anonymous and 404s a foreign file', async () => {
    const anon = mkRes();
    await downloadGeneratedFile(mkReq({ user: undefined }), anon);
    expect(anon.statusCode).toBe(401);
    const foreign = mkRes();
    await downloadGeneratedFile(mkReq({ user: { id: 'u-other' } }), foreign);
    expect(foreign.statusCode).toBe(404);
  });
});
