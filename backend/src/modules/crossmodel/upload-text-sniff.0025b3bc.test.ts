/**
 * Ticket 0025b3bc — plain-text files with unknown extensions (.log, .out,
 * .diff, extensionless) must upload as text/plain instead of being rejected
 * with "Unsupported file type: application/octet-stream".
 *
 * Root cause: browsers declare application/octet-stream (or an empty MIME)
 * for any extension they don't map. detectMimeByExtension had no entry for
 * .log etc., so the generic MIME survived into the dispatch chain, which has
 * a branch for images / PDF / DOCX / XLSX / known text mimes — but none for
 * the generic type → 400 at the fallthrough, even though the bytes are
 * ordinary UTF-8 (rename-to-.txt was the only workaround, discoverable by
 * luck).
 *
 * The fix: resolveGenericMimeBySniff — when the declared/extension-resolved
 * MIME is still generic (application/octet-stream or ''), sniff the BYTES:
 * no NUL and no control chars (bar tab/LF/CR) in the first 8 KB ⇒ text/plain,
 * routed through the existing text branch. Binary content keeps the old 400.
 *
 * This suite pins the pure helpers plus the two processUpload entry paths
 * (JSON base64 body and multipart) so a regression on either surface fails.
 */

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../middleware/auth', () => ({ AuthRequest: {} }));
jest.mock('./ingestion.service', () => ({ processDocument: jest.fn() }));
jest.mock('./pdf-extract', () => ({ extractPdfText: jest.fn() }));
jest.mock('./heic', () => ({ convertHeicToJpeg: jest.fn(), isHeicMime: jest.fn(() => false) }));

import { Response } from 'express';
import {
  processUpload,
  resolveGenericMimeBySniff,
  sniffIsText,
} from './upload.controller';

// The OPTCGSim combat log from the ticket — 77 KB of plain text, declared
// application/octet-stream by the browser because .log is unmapped.
const COMBAT_LOG = [
  '2026-10-25T22:45:29 [Turn 1] Player A plays Roronoa Zoro (OP01-001)',
  '2026-10-25T22:45:31 [Turn 1] Player B responds with Counter +1000',
  '2026-10-25T22:45:33 [Turn 2] Player A attacks with Donquixote Doflamingo',
].join('\n');

function fakeRes() {
  const json = jest.fn().mockReturnThis();
  const res = { status: jest.fn().mockReturnThis(), json } as unknown as Response;
  return { res, status: res.status, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
});

describe('sniffIsText — the byte-level text heuristic (0025b3bc)', () => {
  it('accepts plain ASCII/UTF-8 with newlines and tabs', () => {
    expect(sniffIsText(Buffer.from(COMBAT_LOG, 'utf-8'))).toBe(true);
  });

  it('rejects content containing a NUL byte (binary signature)', () => {
    expect(sniffIsText(Buffer.from('abc\x00def', 'latin1'))).toBe(false);
  });

  it('rejects content with other control bytes (ESC etc.) even without NUL', () => {
    expect(sniffIsText(Buffer.from('abc\x1b[31m', 'latin1'))).toBe(false);
  });

  it('allows tab/LF/CR as the only control characters', () => {
    expect(sniffIsText(Buffer.from('a\tb\rc\nd', 'latin1'))).toBe(true);
  });

  it('only inspects the first 8 KB (a binary tail never vetoes a text head)', () => {
    const head = Buffer.alloc(8 * 1024, 0x41); // 'A' * 8192 — the sniff window
    const tail = Buffer.from([0x00, 0x01, 0x02, 0x03]); // binary beyond the window
    expect(sniffIsText(Buffer.concat([head, tail]))).toBe(true);
  });

  it('a NUL inside the first 8 KB still rejects (window boundary is inclusive)', () => {
    const head = Buffer.alloc(8 * 1024 - 1, 0x41);
    const nul = Buffer.from([0x00]);
    expect(sniffIsText(Buffer.concat([head, nul]))).toBe(false);
  });

  it('multi-byte UTF-8 (Japanese card names) sniffs as text', () => {
    expect(sniffIsText(Buffer.from('ロロノア・ゾロ OP01-001\n', 'utf-8'))).toBe(true);
  });

  it('empty buffer sniffs as text (harmless — the text branch extracts it)', () => {
    expect(sniffIsText(Buffer.alloc(0))).toBe(true);
  });
});

describe('resolveGenericMimeBySniff — generic MIME → text/plain (0025b3bc)', () => {
  it('application/octet-stream + text bytes → text/plain', () => {
    expect(resolveGenericMimeBySniff('application/octet-stream', Buffer.from(COMBAT_LOG))).toBe('text/plain');
  });

  it('empty MIME + text bytes → text/plain (browsers that set no type)', () => {
    expect(resolveGenericMimeBySniff('', Buffer.from('hello\nworld'))).toBe('text/plain');
  });

  it('application/octet-stream + BINARY bytes stays application/octet-stream', () => {
    const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0xff)]);
    expect(resolveGenericMimeBySniff('application/octet-stream', binary)).toBe('application/octet-stream');
  });

  it('a SPECIFIC mime is never overridden (only generic ones are sniffed)', () => {
    // A declared text/csv must stay text/csv even if bytes sniff as text.
    expect(resolveGenericMimeBySniff('text/csv', Buffer.from('a,b\n1,2'))).toBe('text/csv');
    // A declared image/png stays image/png — sniff never rewrites it.
    expect(resolveGenericMimeBySniff('image/png', Buffer.from('not really a png'))).toBe('image/png');
  });
});

describe('processUpload — .log end-to-end (0025b3bc)', () => {
  it('a .log declared application/octet-stream (JSON body path) uploads as a text document', async () => {
    const { res, status, json } = fakeRes();
    await processUpload(
      {
        body: {
          filename: '2026-10-25T22.45.29.log',
          mimeType: 'application/octet-stream',
          base64: Buffer.from(COMBAT_LOG).toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledTimes(1);
    const out = json.mock.calls[0][0] as { type: string; filename: string; uploadId: string };
    expect(out.type).toBe('document');
    expect(out.filename).toBe('2026-10-25T22.45.29.log');
    // The staged attachment carries the sniffed text + the text/plain mime.
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('Roronoa Zoro');
    expect(stored.extractedText).toContain('[Turn 2]');
  });

  it('an extensionless/generic-MIME text file uploads as a text document — multipart path (defensive branch: busboy defaults untyped parts to text/plain, so \'\' is belt-and-suspenders)', async () => {
    const { res, status, json } = fakeRes();
    await processUpload(
      {
        // busboy (multer's parser) DEFAULTS a file part with no Content-Type
        // header to text/plain, so '' never reaches processUpload in
        // production — but detectMimeByExtension has always treated '' as
        // generic, and this pins that the sniff covers it too if a future
        // parser change lets '' through.
        file: {
          originalname: 'COMBAT_LOG',
          mimetype: '',
          buffer: Buffer.from('plain text, no extension\n'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('no extension');
  });

  it('a .out diff-style file uploads as text (ticket named .log/.out/.diff)', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'build.out',
          mimeType: 'application/octet-stream',
          base64: Buffer.from('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n').toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(stored.mimeType).toBe('text/plain');
  });

  it('genuinely binary content with an unknown extension is STILL rejected (400)', async () => {
    const { res, status, json } = fakeRes();
    const binary = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
      Buffer.alloc(1024, 0x9d),
    ]);
    await processUpload(
      {
        body: {
          filename: 'mystery.bin',
          mimeType: 'application/octet-stream',
          base64: binary.toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Unsupported file type: application/octet-stream'),
      }),
    );
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('the multipart path (curl / backward compat) sniffs identically', async () => {
    const { res, status, json } = fakeRes();
    await processUpload(
      {
        // multer leaves originalname + mimetype + buffer on req.file
        file: {
          originalname: 'server.log',
          mimetype: 'application/octet-stream',
          buffer: Buffer.from('2026-10-26T06:00:00Z INFO request handled\n'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('INFO request handled');
  });

  it('the known whitelist is UNCHANGED: .txt declared text/plain still routes to the text branch', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'notes.txt',
          mimeType: 'text/plain',
          base64: Buffer.from('same as before\n').toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toBe('same as before\n');
  });

  it('the known whitelist is UNCHANGED: an extension-mapped generic (.json) keeps its mapped mime', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'data.json',
          mimeType: 'application/octet-stream',
          base64: Buffer.from('{"ok":true}').toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
    // detectMimeByExtension maps .json → application/json BEFORE the sniff,
    // so a specific mime is what reaches the dispatch chain (and the sniff
    // never runs — its input is no longer generic).
    expect(stored.mimeType).toBe('application/json');
  });

  it('a declared image mime is untouched by the sniff (image path regression)', async () => {
    const { res, status, json } = fakeRes();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x00),
    ]);
    await processUpload(
      {
        body: {
          filename: 'photo.png',
          mimeType: 'image/png',
          base64: png.toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].type).toBe('image');
  });
});
