/**
 * Persistent per-chat files (2026-08-25) — chat-files.service persistence +
 * chat-files.controller routes, with a mocked prisma (module-test convention,
 * e.g. upload-attachment.test.ts / crossmodel.controller.stream-attach.test.ts).
 *
 * Pins:
 *  - persistChatUploads: consumed upload → ONE ChatFile row (idempotent per
 *    (uploadId, chatId) — a retry upserts with update:{} and a P2002 race is
 *    swallowed); >25MB skipped; no authed user / no chatId → skipped; a
 *    persistence failure NEVER rejects (the send must still succeed).
 *  - routes: owner lists own files; non-member gets the non-leaking 404;
 *    download serves bytes + RFC 6266 headers; inline rejects disallowed mime
 *    (415); cross-user fileId access is denied as 404.
 *  - schema: GC is by onDelete: Cascade from the parent chat (model-level
 *    assertion — the local idiom for relation guarantees).
 */

const mockUpsert = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockDelete = jest.fn();
const mockUpdate = jest.fn();
const mockPrisma: any = {
  chatFile: {
    upsert: (...a: any[]) => mockUpsert(...a),
    findMany: (...a: any[]) => mockFindMany(...a),
    findUnique: (...a: any[]) => mockFindUnique(...a),
    delete: (...a: any[]) => mockDelete(...a),
    update: (...a: any[]) => mockUpdate(...a),
  },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// middleware/auth's import chain is jest-unsafe (same boundary as
// upload-attachment.test.ts); AuthRequest is a type-only import here.
jest.mock('../../middleware/auth', () => ({ AuthRequest: {} }));

const mockGetChatAccess = jest.fn();
jest.mock('./crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

// The shared extractors (text-extract.ts) are mocked at the module boundary —
// pdf-extract's vision-OCR import chain is jest-unsafe, and the extractors'
// own contracts are pinned by the upload path. extractPlainText keeps its real
// utf-8 decode (pure, no imports).
const mockExtractPdfUploadText = jest.fn();
const mockExtractDocxText = jest.fn();
const mockExtractXlsxText = jest.fn();
jest.mock('./text-extract', () => ({
  extractPlainText: (b: Buffer) => b.toString('utf-8'),
  extractPdfUploadText: (...a: any[]) => mockExtractPdfUploadText(...a),
  extractDocxText: (...a: any[]) => mockExtractDocxText(...a),
  extractXlsxText: (...a: any[]) => mockExtractXlsxText(...a),
}));
// The REAL chat-gate (chatReadAccessGranted) — pure decision module; its only
// runtime import (coding/chat-images) is import-free.

import fs from 'fs';
import path from 'path';
import { persistChatUploads, CHAT_FILE_MAX_BYTES } from './chat-files.service';
import {
  listChatFiles,
  listUserChatFiles,
  downloadChatFile,
  inlineChatFile,
  previewTextChatFile,
  deleteChatFile,
  PREVIEW_TEXT_MAX_CHARS,
  mimeEssence,
  isInlineSafe,
  needsInlineSandbox,
  isUnspecificStoredMime,
} from './chat-files.controller';
import logger from '../../utils/logger';
import type { Attachment } from './upload.controller';

const mockLoggerWarn = logger.warn as jest.Mock;

const IMG: Attachment = {
  type: 'image',
  filename: 'pic.png',
  mimeType: 'image/png',
  base64: Buffer.from('png-bytes').toString('base64'),
};
const DOC: Attachment = {
  type: 'document',
  filename: 'notes.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extractedText: 'extracted body text',
};

const mkReq = (over: any = {}): any => ({
  params: {},
  user: { id: 'u-owner' },
  ...over,
});
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
  mockUpsert.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockFindUnique.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({});
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
});

describe('persistChatUploads', () => {
  it('persists a consumed image upload as ONE ChatFile row (base64 → bytea, decoded size)', async () => {
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up1', attachment: IMG }] });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({ uploadId_chatId: { uploadId: 'up1', chatId: 'c1' } });
    expect(arg.create.chatId).toBe('c1');
    expect(arg.create.userId).toBe('u-owner');
    expect(arg.create.uploadId).toBe('up1');
    expect(arg.create.filename).toBe('pic.png');
    expect(arg.create.mimeType).toBe('image/png');
    expect(arg.create.sizeBytes).toBe(Buffer.from('png-bytes').length);
    expect(Buffer.from(arg.create.data).toString()).toBe('png-bytes');
    // First write wins — never mutate on retry.
    expect(arg.update).toEqual({});
  });

  it('ticket 390b6767: a staged PNG stamped application/octet-stream is stored as image/png (magic bytes win over the generic mime)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up9', attachment: { ...IMG, filename: 'qwen_v1_test.png', mimeType: 'application/octet-stream', base64: png.toString('base64') } as any }] });
    expect(mockUpsert.mock.calls[0][0].create.mimeType).toBe('image/png');
    // a genuine unknown binary keeps octet-stream
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up10', attachment: { type: 'document', filename: 'blob.bin', mimeType: 'application/octet-stream', base64: Buffer.from([0, 1, 2, 3]).toString('base64') } as any }] });
    expect(mockUpsert.mock.calls[1][0].create.mimeType).toBe('application/octet-stream');
  });

  it('ticket 6c050917: a staged AUDIO clip stamped application/octet-stream is stored with its sniffed audio mime (the bake-off WAV class)', async () => {
    const wav = Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8, 1)]);
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up-a1', attachment: { type: 'audio', filename: 'kokoro_af_heart_all4.wav', mimeType: 'application/octet-stream', base64: wav.toString('base64') } as any }] });
    expect(mockUpsert.mock.calls[0][0].create.mimeType).toBe('audio/wav');
    expect(mockUpsert.mock.calls[0][0].create.filename).toBe('kokoro_af_heart_all4.wav');
    // The bytes ride unchanged — a playable copy.
    expect(Buffer.from(mockUpsert.mock.calls[0][0].create.data).equals(wav)).toBe(true);
  });

  it('ticket 6c050917: an audio-typed attachment with a generic mime and NO recognizable magic falls back to audio/wav (never image/png)', async () => {
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up-a2', attachment: { type: 'audio', filename: 'clip', mimeType: 'application/octet-stream', base64: Buffer.from([9, 9, 9, 9]).toString('base64') } as any }] });
    expect(mockUpsert.mock.calls[0][0].create.mimeType).toBe('audio/wav');
  });

  it('ticket 6c050917: a staged audio clip with a REAL declared mime keeps it verbatim', async () => {
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up-a3', attachment: { type: 'audio', filename: 'voice.mp3', mimeType: 'audio/mpeg', base64: Buffer.from([0xff, 0xfb, 1, 2]).toString('base64') } as any }] });
    expect(mockUpsert.mock.calls[0][0].create.mimeType).toBe('audio/mpeg');
  });

  it('retry of the same message cannot duplicate: same upsert key, update stays {} (idempotent)', async () => {
    const loaded = [{ id: 'up1', attachment: IMG }];
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded });
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    for (const call of mockUpsert.mock.calls) {
      expect(call[0].where).toEqual({ uploadId_chatId: { uploadId: 'up1', chatId: 'c1' } });
      expect(call[0].update).toEqual({});
    }
  });

  it('swallows a P2002 unique race silently (concurrent persist won — desired end state)', async () => {
    mockUpsert.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(
      persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up1', attachment: IMG }] }),
    ).resolves.toBeUndefined();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('skips files over the 25MB cap (logged, no row) while smaller siblings persist', async () => {
    const big: Attachment = {
      type: 'image',
      filename: 'huge.png',
      mimeType: 'image/png',
      base64: Buffer.alloc(CHAT_FILE_MAX_BYTES + 1, 1).toString('base64'),
    };
    await persistChatUploads({
      chatId: 'c1',
      userId: 'u-owner',
      loaded: [{ id: 'up-big', attachment: big }, { id: 'up1', attachment: IMG }],
    });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].where.uploadId_chatId.uploadId).toBe('up1');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('skips when there is no authed user or no chatId', async () => {
    await persistChatUploads({ chatId: 'c1', userId: undefined, loaded: [{ id: 'up1', attachment: IMG }] });
    await persistChatUploads({ chatId: null, userId: 'u-owner', loaded: [{ id: 'up1', attachment: IMG }] });
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [] });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('a persistence failure never rejects and never stops the remaining files (send must succeed)', async () => {
    mockUpsert
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({});
    await expect(
      persistChatUploads({
        chatId: 'c1',
        userId: 'u-owner',
        loaded: [
          { id: 'up-fails', attachment: IMG },
          { id: 'up-ok', attachment: IMG },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('up-fails'));
  });

  it('documents persist their extracted text as text/plain UTF-8 (staging keeps no binary)', async () => {
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up-doc', attachment: DOC }] });
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.create.mimeType).toBe('text/plain');
    expect(arg.create.sizeBytes).toBe(Buffer.from('extracted body text', 'utf8').length);
    expect(Buffer.from(arg.create.data).toString('utf8')).toBe('extracted body text');
  });

  it('skips attachments with no persistable content (no base64, no text)', async () => {
    const empty: Attachment = { type: 'document', filename: 'empty.bin' };
    await persistChatUploads({ chatId: 'c1', userId: 'u-owner', loaded: [{ id: 'up0', attachment: empty }] });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('GET /chats/:chatId/files (listChatFiles)', () => {
  const ROWS = [
    { id: 'f2', uploadId: 'up2', filename: 'b.png', mimeType: 'image/png', sizeBytes: 10, createdAt: new Date('2026-08-25T02:00:00Z') },
    { id: 'f1', uploadId: 'up1', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 20, createdAt: new Date('2026-08-25T01:00:00Z') },
  ];

  it('owner lists own files — metadata only, newest-first', async () => {
    mockFindMany.mockResolvedValue(ROWS);
    const res = mkRes();
    await listChatFiles(mkReq({ params: { chatId: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { files: ROWS } });
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: 'c1' },
      orderBy: { createdAt: 'desc' },
    }));
    // metadata projection only — never the bytea payload
    const select = mockFindMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ id: true, uploadId: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true });
    expect(select.data).toBeUndefined();
  });

  it('a project VIEWER (read access) lists too — same gate as reading messages', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'read', exists: true });
    const res = mkRes();
    await listChatFiles(mkReq({ params: { chatId: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('non-member gets the non-leaking 404 (no findMany)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    const res = mkRes();
    await listChatFiles(mkReq({ params: { chatId: 'c1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('missing chat is the same 404', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    const res = mkRes();
    await listChatFiles(mkReq({ params: { chatId: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
  });
});

describe('byte routes (downloadChatFile / inlineChatFile)', () => {
  const FILE = {
    id: 'f1',
    chatId: 'c1',
    userId: 'u-owner',
    uploadId: 'up1',
    filename: 'résumé.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 11,
    data: Buffer.from('%PDF-1.7 x'),
    createdAt: new Date(),
  };

  it('download serves bytes with RFC 6266 attachment headers (ASCII fallback + UTF-8 filename*)', async () => {
    mockFindUnique.mockResolvedValue(FILE);
    const res = mkRes();
    await downloadChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Length']).toBe(FILE.data.length);
    expect(res.headers['Content-Disposition']).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''${encodeURIComponent('résumé.pdf')}`,
    );
    expect(Buffer.from(res.body).equals(FILE.data)).toBe(true);
  });

  it('inline serves an image with Content-Disposition: inline + nosniff', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.png', mimeType: 'image/png' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Disposition']).toContain('inline;');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('inline rejects a disallowed mime family with 415', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, mimeType: 'application/vnd.ms-excel' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(415);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('scripting-capable inline types (text/html) ride a CSP sandbox — no stored-XSS on the app origin', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.html', mimeType: 'text/html' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Security-Policy']).toBe('sandbox');
  });

  it('B1: a PARAMETERIZED stored svg mime is sandboxed AND served as the bare essence', async () => {
    // The exact bypass: JSON upload persists `image/svg+xml; charset=utf-8`
    // verbatim — before the fix it passed the image/* family check yet dodged
    // the exact-match sandbox predicate (served inline unsandboxed).
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.svg', mimeType: 'image/svg+xml; charset=utf-8' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Security-Policy']).toBe('sandbox');
    expect(res.headers['Content-Type']).toBe('image/svg+xml');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('B1: whitespace/case variants of svg and html are sandboxed, served normalized', async () => {
    for (const [stored, essence] of [
      [' image/SVG+XML ', 'image/svg+xml'],
      ['Text/HTML;charset=utf-8', 'text/html'],
    ] as const) {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p', mimeType: stored });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Security-Policy']).toBe('sandbox');
      expect(res.headers['Content-Type']).toBe(essence);
    }
  });

  it('served Content-Type is the normalized essence even for a parameterized benign mime', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.png', mimeType: 'image/png; charset=binary' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
  });

  it('regression: plain image/png stays inline with NO sandbox header (CSP would break nothing but is not added)', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.png', mimeType: 'image/png' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
  });

  it('regression: a disallowed essence (application/zip) is still 415', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, filename: 'a.zip', mimeType: 'application/zip' });
    const res = mkRes();
    await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(415);
    expect(res.send).not.toHaveBeenCalled();
  });

  // Ticket 390b6767 — lazy mime heal at the serve path. Rows persisted before
  // the stagedMime fix (2ab2ab99b) carry application/octet-stream (or an empty
  // mime); for those the BYTES are the only truth, so the inline route sniffs
  // the real type, serves it, and backfills the row.
  describe('ticket 390b6767: lazy mime heal on serve (octet-stream/empty stored mime)', () => {
    const PNG_MAGIC = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    it('an octet-stream row with PNG magic serves 200 image/png inline AND backfills the row', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'qwen_v1_test.png', mimeType: 'application/octet-stream', data: PNG_MAGIC, sizeBytes: PNG_MAGIC.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(res.headers['Content-Disposition']).toContain('inline;');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      // No sandbox: sniffMime can only ever yield raster types (png/jpeg/
      // gif/webp) — the B1 svg/html sandbox surface is unreachable here.
      expect(res.headers['Content-Security-Policy']).toBeUndefined();
      expect(Buffer.from(res.body).equals(PNG_MAGIC)).toBe(true);
      // The heal persists — one row, as served.
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate.mock.calls[0][0]).toEqual({ where: { id: 'f1' }, data: { mimeType: 'image/png' } });
    });

    it('an EMPTY stored mime with PNG magic heals the same way', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'qwen_v1_test.png', mimeType: '', data: PNG_MAGIC, sizeBytes: PNG_MAGIC.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { mimeType: 'image/png' } });
    });

    it('non-image magic (ELF) keeps its unspecific mime → 415 inline, no backfill', async () => {
      // ELF magic: no image signature — the stored octet-stream stands and the
      // inline route refuses it, exactly as before the heal.
      const ELF = Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(20, 1)]);
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'blob.bin', mimeType: 'application/octet-stream', data: ELF, sizeBytes: ELF.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(415);
      expect(res.send).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('the DOWNLOAD route heals + backfills too (serves image/png with attachment disposition)', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'qwen_v1_test.png', mimeType: 'application/octet-stream', data: PNG_MAGIC, sizeBytes: PNG_MAGIC.length });
      const res = mkRes();
      await downloadChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(res.headers['Content-Disposition']).toContain('attachment;');
      expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { mimeType: 'image/png' } });
    });

    it('a SPECIFIC stored mime is never re-sniffed (an octet-stream-labelled row is, a real image/png row is not)', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'p.png', mimeType: 'image/png' });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('a backfill failure never fails the serve (fire-and-forget contract)', async () => {
      const err = new Error('db down');
      let caught: unknown = null;
      mockUpdate.mockImplementation(() => ({ catch: (fn: (e: unknown) => void) => { caught = fn(err); return undefined; } }));
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'qwen_v1_test.png', mimeType: 'application/octet-stream', data: PNG_MAGIC, sizeBytes: PNG_MAGIC.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
      // The rejection was routed to logger.warn — the serve is unaffected.
      expect(caught).toBeUndefined(); // catch consumed the rejection (no unhandled promise)
    });

    it('isUnspecificStoredMime: octet-stream/empty/null heal candidates; anything specific does not', () => {
      expect(isUnspecificStoredMime('application/octet-stream')).toBe(true);
      expect(isUnspecificStoredMime('APPLICATION/OCTET-STREAM; charset=binary')).toBe(true);
      expect(isUnspecificStoredMime('')).toBe(true);
      expect(isUnspecificStoredMime(null)).toBe(true);
      expect(isUnspecificStoredMime(undefined)).toBe(true);
      expect(isUnspecificStoredMime('image/png')).toBe(false);
      expect(isUnspecificStoredMime('application/zip')).toBe(false);
      expect(isUnspecificStoredMime('text/plain')).toBe(false);
    });
  });

  // Ticket 6c050917 — inline AUDIO. audio/* joins the inline-safe families
  // (the chat UI's AudioFilePlayer fetches the byte route with auth), and the
  // lazy mime heal learns the audio twin so the persisted bake-off/voice WAV
  // rows staged as octet-stream before this fix self-heal on first serve.
  describe('ticket 6c050917: inline audio serving + the audio mime heal', () => {
    const WAV_MAGIC = Buffer.from('52494646', 'hex'); // 'RIFF'
    const wav = Buffer.concat([WAV_MAGIC, Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8, 1)]);

    it('inline serves a stored audio/wav row with inline disposition (no sandbox, no nosniff change)', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'kokoro_af_heart_all4.wav', mimeType: 'audio/wav', data: wav, sizeBytes: wav.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('audio/wav');
      expect(res.headers['Content-Disposition']).toContain('inline;');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      // audio is not a scripting-capable essence — no CSP sandbox.
      expect(res.headers['Content-Security-Policy']).toBeUndefined();
      expect(mockUpdate).not.toHaveBeenCalled(); // a SPECIFIC mime is never re-sniffed
    });

    it('inline serves the other audio essences (mpeg, mp4/m4a, ogg, flac, webm)', async () => {
      for (const mimeType of ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/webm']) {
        mockFindUnique.mockResolvedValue({ ...FILE, filename: 'clip', mimeType, data: wav, sizeBytes: wav.length });
        const res = mkRes();
        await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe(mimeType);
      }
    });

    it('an octet-stream row with RIFF/WAVE magic heals to audio/wav and serves inline (the bake-off class)', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'phonon-31m-en_Easton_all4.wav', mimeType: 'application/octet-stream', data: wav, sizeBytes: wav.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('audio/wav');
      expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { mimeType: 'audio/wav' } });
    });

    it('an mp4 VIDEO ftyp (isom brand) does NOT heal to audio — octet-stream stands, 415 inline', async () => {
      // 'ftypisom' — a video container: sniffAudioMime must not claim it.
      const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8, 1)]);
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'clip.mp4', mimeType: 'application/octet-stream', data: mp4, sizeBytes: mp4.length });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(415);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('a DISALLOWED family (application/zip) is still 415 — audio joining inline-safe loosens nothing else', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'a.zip', mimeType: 'application/zip', data: Buffer.from('PK') , sizeBytes: 2 });
      const res = mkRes();
      await inlineChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(415);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('download serves an audio row with attachment disposition (the explicit download affordance)', async () => {
      mockFindUnique.mockResolvedValue({ ...FILE, filename: 'clip.wav', mimeType: 'audio/wav', data: wav, sizeBytes: wav.length });
      const res = mkRes();
      await downloadChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('audio/wav');
      expect(res.headers['Content-Disposition']).toContain('attachment;');
    });
  });

  it('cross-user fileId access is denied as 404 (never leak existence)', async () => {
    mockFindUnique.mockResolvedValue(FILE);
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    const res = mkRes();
    await downloadChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('a project member (write access, non-owner) may download a chat file', async () => {
    mockFindUnique.mockResolvedValue(FILE);
    mockGetChatAccess.mockResolvedValue({ access: 'write', exists: true });
    const res = mkRes();
    await downloadChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeTruthy();
  });

  it('a missing file is 404', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = mkRes();
    await downloadChatFile(mkReq({ params: { fileId: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /files/:fileId/preview-text (previewTextChatFile)', () => {
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const mkFile = (over: any = {}) => ({
    id: 'f1',
    chatId: 'c1',
    userId: 'u-owner',
    uploadId: 'up1',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 5,
    data: Buffer.from('hello world'),
    createdAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    mockExtractPdfUploadText.mockResolvedValue('pdf text');
    mockExtractDocxText.mockResolvedValue('docx body');
    mockExtractXlsxText.mockResolvedValue('[Sheet: A]\na\tb');
  });

  it('text/* decodes utf-8 directly (no extractor call)', async () => {
    mockFindUnique.mockResolvedValue(mkFile());
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { text: 'hello world', truncated: false } });
    expect(mockExtractDocxText).not.toHaveBeenCalled();
  });

  it('docx rides the mammoth extractor', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ filename: 'n.docx', mimeType: DOCX_MIME }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ text: 'docx body', truncated: false });
    expect(mockExtractDocxText).toHaveBeenCalledTimes(1);
  });

  it('xlsx + legacy xls ride the exceljs extractor', async () => {
    for (const mimeType of [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ]) {
      jest.clearAllMocks();
      mockFindUnique.mockResolvedValue(mkFile({ filename: 's.xls', mimeType }));
      mockExtractXlsxText.mockResolvedValue('[Sheet: A]\na\tb');
      mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
      const res = mkRes();
      await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
      expect(res.statusCode).toBe(200);
      expect(mockExtractXlsxText).toHaveBeenCalledTimes(1);
    }
  });

  it('pdf rides the pdf extractor', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ filename: 'p.pdf', mimeType: 'application/pdf' }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ text: 'pdf text', truncated: false });
  });

  it('a PARAMETERIZED stored mime dispatches on its essence', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ mimeType: 'text/markdown; charset=utf-8' }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('over-cap text is sliced to PREVIEW_TEXT_MAX_CHARS with truncated:true', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ data: Buffer.from('x'.repeat(PREVIEW_TEXT_MAX_CHARS + 10)) }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.text.length).toBe(PREVIEW_TEXT_MAX_CHARS);
  });

  it('images 415 (the modal renders those from the inline byte route)', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ filename: 'p.png', mimeType: 'image/png' }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(415);
  });

  it('unknown families 415', async () => {
    mockFindUnique.mockResolvedValue(mkFile({ filename: 'a.zip', mimeType: 'application/zip' }));
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(415);
  });

  it('missing file and non-member both get the non-leaking 404', async () => {
    mockFindUnique.mockResolvedValue(null);
    let res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    mockFindUnique.mockResolvedValue(mkFile());
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
  });

  it('a project member (read access) may preview', async () => {
    mockFindUnique.mockResolvedValue(mkFile());
    mockGetChatAccess.mockResolvedValue({ access: 'read', exists: true });
    const res = mkRes();
    await previewTextChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
  });
});

describe('mime essence predicates (B1 unit pins)', () => {
  it('mimeEssence strips parameters, surrounding whitespace and case', () => {
    expect(mimeEssence('image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
    expect(mimeEssence(' image/SVG+XML ')).toBe('image/svg+xml');
    expect(mimeEssence('Text/HTML;charset=utf-8')).toBe('text/html');
    expect(mimeEssence('application/pdf')).toBe('application/pdf');
  });

  it('needsInlineSandbox catches the exact B1 bypass plus whitespace/case variants', () => {
    expect(needsInlineSandbox('image/svg+xml; charset=utf-8')).toBe(true);
    expect(needsInlineSandbox(' image/SVG+XML ')).toBe(true);
    expect(needsInlineSandbox('Text/HTML;charset=utf-8')).toBe(true);
    // non-scripting essences stay UNSANDBOXED
    expect(needsInlineSandbox('image/png')).toBe(false);
    expect(needsInlineSandbox('application/pdf')).toBe(false);
    expect(needsInlineSandbox('text/plain; charset=utf-8')).toBe(false);
  });

  it('isInlineSafe applies the family check to the essence (parameters/whitespace/case irrelevant)', () => {
    expect(isInlineSafe('image/svg+xml; charset=utf-8')).toBe(true);
    expect(isInlineSafe(' image/png ')).toBe(true);
    expect(isInlineSafe('Application/PDF')).toBe(true);
    expect(isInlineSafe('text/plain; charset=utf-8')).toBe(true);
    expect(isInlineSafe('application/zip')).toBe(false);
    expect(isInlineSafe('application/zip; x=1')).toBe(false);
  });
});

describe('GET /files (listUserChatFiles — global Files page)', () => {
  it('lists the caller’s own uploads across chats — metadata + chatId, never the payload', async () => {
    const ROWS = [
      { id: 'f2', uploadId: 'up2', chatId: 'c2', filename: 'b.png', mimeType: 'image/png', sizeBytes: 10, createdAt: new Date() },
    ];
    mockFindMany.mockResolvedValue(ROWS);
    const res = mkRes();
    await listUserChatFiles(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { files: ROWS } });
    const q = mockFindMany.mock.calls[0][0];
    expect(q.where).toEqual({ userId: 'u-owner' });
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
    expect(q.select.chatId).toBe(true);
    expect(q.select.data).toBeUndefined();
  });
});

describe('DELETE /files/:fileId (deleteChatFile)', () => {
  const FILE = { id: 'f1', chatId: 'c1', userId: 'u-owner', filename: 'p.png', mimeType: 'image/png', data: Buffer.from('x') };

  it('the uploader deletes their own file', async () => {
    mockFindUnique.mockResolvedValue(FILE);
    mockDelete.mockResolvedValue({});
    const res = mkRes();
    await deleteChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'f1' } });
  });

  it('not-owner gets the non-leaking 404 (no delete)', async () => {
    mockFindUnique.mockResolvedValue({ ...FILE, userId: 'u-other' });
    const res = mkRes();
    await deleteChatFile(mkReq({ params: { fileId: 'f1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('a missing file is the same 404', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = mkRes();
    await deleteChatFile(mkReq({ params: { fileId: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('ChatFile schema (GC by cascade — model-level idiom)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const block = schema.slice(schema.indexOf('model ChatFile {'));
  const modelBody = block.slice(0, block.indexOf('\n}'));

  it('chat relation cascades on delete (files die with their chat)', () => {
    expect(modelBody).toMatch(/chat\s+CrossModelChat\s+@relation\(fields:\s*\[chatId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  });

  it('idempotency + read indexes are declared', () => {
    expect(modelBody).toContain('@@unique([uploadId, chatId])');
    expect(modelBody).toContain('@@index([chatId, createdAt])');
  });
});
