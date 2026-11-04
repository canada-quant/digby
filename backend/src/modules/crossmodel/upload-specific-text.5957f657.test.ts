/**
 * Ticket 5957f657 — residual specific text/* mime rejections after 0025b3bc.
 *
 * 0025b3bc rescued GENERIC mimes only (application/octet-stream / ''). A
 * SPECIFIC text/* mime the dispatch chain has no branch for — an OS/browser-
 * mapped .diff arriving as text/x-diff, a .log as text/x-log — still 400ed
 * with "Unsupported file type: text/x-diff", even though the bytes are plain
 * text. The adjudication of PR #1983 proved the gaps by probe on tree
 * 37e1d57f0:
 *
 *   GAP-A         .diff + text/x-diff            → 400
 *   GAP-E         .log  + text/x-log             → 400
 *   COUNTERFACTUAL .txt + text/x-log (gate-passing extension, unmapped
 *                  specific mime → dispatch fallthrough) → 400
 *   BROWSER-CASE  .out  + octet-stream           → green (0025b3bc covers)
 *   CURL-DEFAULT  .patch multipart (no part type) → green (0025b3bc covers)
 *
 * The fix: resolveUploadMime — the one seam both upload paths share — now
 * also normalizes an UNMAPPED specific text/* mime to text/plain when the
 * bytes pass sniffIsText. Known text mimes (plain/csv/markdown/xml) keep
 * their identity and dedicated dispatch branches. Binary content keeps the
 * declared mime and the old 400 (a .zip renamed "text/x-anything" gains
 * nothing). The multer fileFilter additionally lets explicitly-typed text/*
 * parts THROUGH to the controller (they used to be dropped there, before any
 * sniff could judge them) — the controller stays the enforcement point.
 *
 * This suite pins the pure helpers, the JSON body path, and — the hardening
 * half the ticket asked for — the REAL multipart path: uploadMiddleware over
 * an ephemeral express app (app.listen(0) + fetch, the route-posture idiom),
 * so the fileFilter + busboy parsing are exercised for real, not fabricated
 * via a hand-built req.file.
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

import express, { Express } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { Response } from 'express';
import {
  processUpload,
  resolveSpecificTextMimeBySniff,
  resolveUploadMime,
} from './upload.controller';

// A real unified diff — plain ASCII with tabs/newlines, exactly what an OS
// maps to text/x-diff when it hands the file to the browser.
const UNIFIED_DIFF = [
  'diff --git a/backend/src/x.ts b/backend/src/x.ts',
  'index 0a1b2c3..4d5e6f7 100644',
  '--- a/backend/src/x.ts',
  '+++ b/backend/src/x.ts',
  '@@ -10,4 +10,5 @@ export function x() {',
  '   const a = 1;',
  '-  const b = 2;',
  '+  const b = 3;',
  '+  const c = 4;',
  '   return a + b;',
  ' }',
].join('\n');

// A plain server log — what an OS maps to text/x-log.
const SERVER_LOG = [
  '2026-10-26T08:00:00Z INFO  request handled in 12ms',
  '2026-10-26T08:00:01Z WARN  retrying upstream (attempt 1)',
  '2026-10-26T08:00:02Z ERROR upstream timed out after 5000ms',
].join('\n');

const BINARY = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
  Buffer.alloc(256, 0xff),
]);

function fakeRes() {
  const json = jest.fn().mockReturnThis();
  const res = { status: jest.fn().mockReturnThis(), json } as unknown as Response;
  return { res, status: res.status, json };
}

/** The last attachment saveAttachment stashed to Redis, decoded. */
function storedAttachment(): any {
  expect(mockRedis.set).toHaveBeenCalled();
  return JSON.parse(mockRedis.set.mock.calls[0][1]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('resolveSpecificTextMimeBySniff — unmapped specific text/* → text/plain (5957f657)', () => {
  it('text/x-diff + text bytes → text/plain (GAP-A)', () => {
    expect(resolveSpecificTextMimeBySniff('text/x-diff', Buffer.from(UNIFIED_DIFF))).toBe('text/plain');
  });

  it('text/x-log + text bytes → text/plain (GAP-E)', () => {
    expect(resolveSpecificTextMimeBySniff('text/x-log', Buffer.from(SERVER_LOG))).toBe('text/plain');
  });

  it('any unmapped text/* subtype with text bytes resolves (text/x-python, text/javascript, …)', () => {
    expect(resolveSpecificTextMimeBySniff('text/x-python', Buffer.from('print("hi")\n'))).toBe('text/plain');
    expect(resolveSpecificTextMimeBySniff('text/javascript', Buffer.from('console.log(1);\n'))).toBe('text/plain');
    expect(resolveSpecificTextMimeBySniff('text/html', Buffer.from('<p>hello</p>\n'))).toBe('text/plain');
  });

  it('KNOWN text mimes are never rewritten — they have dedicated dispatch branches', () => {
    expect(resolveSpecificTextMimeBySniff('text/plain', Buffer.from('a'))).toBe('text/plain');
    expect(resolveSpecificTextMimeBySniff('text/csv', Buffer.from('a,b\n1,2'))).toBe('text/csv');
    expect(resolveSpecificTextMimeBySniff('text/markdown', Buffer.from('# hi'))).toBe('text/markdown');
    expect(resolveSpecificTextMimeBySniff('text/xml', Buffer.from('<a/>'))).toBe('text/xml');
  });

  it('text/* on BINARY bytes keeps the declared mime (the dispatch fallthrough still 400s it)', () => {
    expect(resolveSpecificTextMimeBySniff('text/x-diff', BINARY)).toBe('text/x-diff');
    expect(resolveSpecificTextMimeBySniff('text/x-anything', BINARY)).toBe('text/x-anything');
  });

  it('generic and non-text mimes pass through untouched (0025b3bc owns those)', () => {
    expect(resolveSpecificTextMimeBySniff('application/octet-stream', Buffer.from('text'))).toBe('application/octet-stream');
    expect(resolveSpecificTextMimeBySniff('', Buffer.from('text'))).toBe('');
    expect(resolveSpecificTextMimeBySniff('image/png', BINARY)).toBe('image/png');
  });
});

describe('resolveUploadMime — the composed seam both upload paths share (5957f657)', () => {
  it('.diff declared text/x-diff → text/plain', () => {
    expect(resolveUploadMime('fix.diff', 'text/x-diff', Buffer.from(UNIFIED_DIFF))).toBe('text/plain');
  });

  it('.log declared text/x-log → text/plain', () => {
    expect(resolveUploadMime('server.log', 'text/x-log', Buffer.from(SERVER_LOG))).toBe('text/plain');
  });

  it('COUNTERFACTUAL: a gate-passing extension (.txt) carrying text/x-log also resolves (the old dispatch-fallthrough 400)', () => {
    expect(resolveUploadMime('notes.txt', 'text/x-log', Buffer.from(SERVER_LOG))).toBe('text/plain');
  });

  it('the 0025b3bc behaviors compose unchanged (generic sniff first, ext-map still wins for generic mimes)', () => {
    expect(resolveUploadMime('combat.log', 'application/octet-stream', Buffer.from(SERVER_LOG))).toBe('text/plain');
    expect(resolveUploadMime('data.json', 'application/octet-stream', Buffer.from('{"ok":true}'))).toBe('application/json');
    expect(resolveUploadMime('notes.txt', 'text/plain', Buffer.from('hi'))).toBe('text/plain');
  });

  // Review round (adversarial findings 1 + 3): the seam normalizes the
  // declared mime to its RFC 2045 base form — parameters stripped, case
  // lowered. Before normalization these forms matched NO dispatch branch and
  // 400ed (or, worse, mislabeled).
  it('parameterized mimes keep their family routing: text/csv; charset=utf-8 → text/csv (NOT rewritten to text/plain)', () => {
    expect(resolveUploadMime('data.csv', 'text/csv; charset=utf-8', Buffer.from('a,b\n1,2'))).toBe('text/csv');
    expect(resolveUploadMime('data.csv', 'text/plain; charset=utf-8', Buffer.from('a,b\n1,2'))).toBe('text/plain');
  });

  it('uppercase mimes resolve like their lowercase forms (TEXT/X-DIFF → text/plain, was a 400)', () => {
    expect(resolveUploadMime('fix.diff', 'TEXT/X-DIFF', Buffer.from(UNIFIED_DIFF))).toBe('text/plain');
    expect(resolveUploadMime('notes.txt', 'Text/Plain; Charset=UTF-8', Buffer.from('hi'))).toBe('text/plain');
    expect(resolveUploadMime('data.csv', 'TEXT/CSV', Buffer.from('a,b'))).toBe('text/csv');
  });
});

// ─── processUpload — JSON body path (the browser surface) ─────────────────────

describe('processUpload — specific text/* mimes on the JSON body path (5957f657)', () => {
  it('GAP-A: a .diff declared text/x-diff uploads as a text document, not 400', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'fix.diff',
          mimeType: 'text/x-diff',
          base64: Buffer.from(UNIFIED_DIFF).toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = storedAttachment();
    expect(stored.type).toBe('document');
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('diff --git a/backend/src/x.ts');
    expect(stored.extractedText).toContain('+  const c = 4;');
  });

  it('GAP-E: a .log declared text/x-log uploads as a text document, not 400', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'server.log',
          mimeType: 'text/x-log',
          base64: Buffer.from(SERVER_LOG).toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    const stored = storedAttachment();
    expect(stored.type).toBe('document');
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('upstream timed out after 5000ms');
  });

  it('COUNTERFACTUAL: a gate-passing .txt carrying text/x-log no longer falls through the dispatch chain to 400', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'notes.txt',
          mimeType: 'text/x-log',
          base64: Buffer.from(SERVER_LOG).toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    expect(storedAttachment().mimeType).toBe('text/plain');
  });

  it('BINARY content declared text/x-diff is STILL rejected (400) — the sniff is the gate, not the label', async () => {
    const { res, status, json } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'not-really-a-diff.diff',
          mimeType: 'text/x-diff',
          base64: BINARY.toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Unsupported file type: text/x-diff'),
      }),
    );
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('the known text mimes keep their dedicated branches (text/csv still routes as CSV, not rewritten)', async () => {
    const { res, status } = fakeRes();
    await processUpload(
      {
        body: {
          filename: 'data.csv',
          mimeType: 'text/csv',
          base64: Buffer.from('a,b\n1,2').toString('base64'),
        },
      } as any,
      res,
    );
    expect(status).not.toHaveBeenCalledWith(400);
    expect(storedAttachment().mimeType).toBe('text/csv');
  });
});

// ─── processUpload — REAL multipart path (the ticket's hardening ask) ─────────
//
// Drives the actual uploadMiddleware (multer + busboy) over an ephemeral
// express server instead of fabricating req.file — so the fileFilter seam
// this ticket widened (explicitly-typed text/* parts used to be silently
// dropped THERE, before any sniff could judge them) is exercised for real.

describe('processUpload — real multipart over the real uploadMiddleware (5957f657)', () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    app = express();
    // Exactly the production wiring (crossmodel-open.routes.ts): the real
    // middleware, then the real controller. optionalAuthenticate omitted —
    // anonymous uploads are the documented production case.
    app.post('/api/crossmodel/upload', (req, res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { uploadMiddleware } = jest.requireActual('./upload.controller') as typeof import('./upload.controller');
      uploadMiddleware(req, res, next);
    }, processUpload as any);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('an explicitly-typed text/x-diff part passes the fileFilter and uploads as a text document', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(UNIFIED_DIFF)], { type: 'text/x-diff' }), 'fix.diff');
    const res = await fetch(`${baseUrl}/api/crossmodel/upload`, { method: 'POST', body: form });
    // Before the fix: multer's fileFilter silently dropped the part, so
    // processUpload saw no file and answered 400 "No file provided…".
    expect(res.status).toBe(200);
    const out = (await res.json()) as { type: string };
    expect(out.type).toBe('document');
    const stored = storedAttachment();
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('diff --git');
  });

  it('an explicitly-typed text/x-log part passes the fileFilter and uploads as a text document', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(SERVER_LOG)], { type: 'text/x-log' }), 'server.log');
    const res = await fetch(`${baseUrl}/api/crossmodel/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const stored = storedAttachment();
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('INFO  request handled');
  });

  it('BINARY content typed text/x-diff still 400s through the real middleware (sniff gates, label does not)', async () => {
    const form = new FormData();
    form.append('file', new Blob([BINARY], { type: 'text/x-diff' }), 'trojan.diff');
    const res = await fetch(`${baseUrl}/api/crossmodel/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain('Unsupported file type: text/x-diff');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('a typeless part (curl -F default) still uploads as text — busboy defaults the part to text/plain', async () => {
    // Review round (adversarial finding 2): undici's FormData always emits a
    // part Content-Type (application/octet-stream for an untyped Blob), so a
    // FormData-built request can never reach busboy's no-Content-Type
    // default. Craft the multipart body RAW — a file part with NO
    // Content-Type header — exactly what `curl -F file=@script.patch` sends.
    const body = Buffer.from(
      `--5957f657boundary\r\n` +
      `Content-Disposition: form-data; name="file"; filename="script.patch"\r\n` +
      `\r\n` +
      `curl --no-type\r\n` +
      `--5957f657boundary--\r\n`,
    );
    const res = await fetch(`${baseUrl}/api/crossmodel/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=5957f657boundary' },
      body,
    });
    expect(res.status).toBe(200);
    const stored = storedAttachment();
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.extractedText).toContain('curl --no-type');
  });

  it('a genuinely disallowed typed part (video/mp4) is still dropped by the fileFilter → "No file provided" 400', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(64, 0x00)], { type: 'video/mp4' }), 'clip.mp4');
    const res = await fetch(`${baseUrl}/api/crossmodel/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain('No file provided');
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
