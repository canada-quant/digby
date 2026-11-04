/**
 * google-mcp multi-account resolution + fan-out.
 *
 * History: the 2026-08-08→08-11 reports were "second connected Google account
 * reads silently hit the FIRST account" (fixed by threading a label through).
 * The audit follow-up hardened resolution itself: the label used to be an
 * exact case-sensitive DB match, but the only place models ever SEE labels is
 * the fan-out section headers ('--- Label (email) ---'), so 'work',
 * 'paul@work.com' and 'Work (paul@work.com)' all failed as "not found".
 * resolveGoogleAccount now matches case-insensitively against the bare label,
 * the email, and the displayed composite, distinguishes not_connected /
 * refresh_failed / label_not_found (listing the valid labels), and the drive/
 * doc/sheet/message reads fan out across accounts when no label is given.
 *
 * Boundaries mocked per repo convention: ./token-manager (its graph reaches
 * config/database → config/env, which process.exit(1)s at import), axios, and
 * utils/logger. GOOGLE_MCP_API_KEY is set BEFORE the module loads (it is read
 * at import time) so calls reach the mocked transport, where the
 * X-Google-Token header proves which account was resolved.
 */

export {}; // keep this file a TS module (no top-level imports — env is set before require)

const mockGetAllValidTokens: jest.Mock = jest.fn(async () => []);
const mockHasGoogleConnected: jest.Mock = jest.fn(async () => false);
const mockPost: jest.Mock = jest.fn();
const mockExtractPdfText: jest.Mock = jest.fn(async () => '');
const mockMammothExtract: jest.Mock = jest.fn(async () => ({ value: '' }));
// The vision hop images route to (d3cfbb44) — google-mcp requires it LAZILY,
// but jest.mock still intercepts the require, so the hop is controllable here.
const mockDescribeImageWithVision: jest.Mock = jest.fn(async () => '');

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./token-manager', () => ({
  __esModule: true,
  getAllValidTokens: (...a: any[]) => mockGetAllValidTokens(...a),
  hasGoogleConnected: (...a: any[]) => mockHasGoogleConnected(...a),
}));

jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

jest.mock('../pdf-extract', () => ({
  __esModule: true,
  extractPdfText: (...a: any[]) => mockExtractPdfText(...a),
}));

jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribeImageWithVision(...a),
}));

jest.mock('mammoth', () => ({
  __esModule: true,
  extractRawText: (...a: any[]) => mockMammothExtract(...a),
}));

process.env.GOOGLE_MCP_API_KEY = 'test-key';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gm = require('./google-mcp') as typeof import('./google-mcp');

const ACCOUNTS = [
  { token: 'tok-personal', label: 'Personal', email: 'paul@gmail.com' },
  { token: 'tok-work', label: 'Work', email: 'paul@work.com' },
];

/** Build an SSE response whose JSON-RPC id mirrors the request body's id. */
function sseImplementation(buildResult: (callIndex: number) => any) {
  let call = 0;
  return async (_url: string, body: any) => {
    const payload = { jsonrpc: '2.0', id: body.id, result: buildResult(call++) };
    const handlers: Record<string, (...a: any[]) => void> = {};
    const stream = {
      on(event: string, cb: (...a: any[]) => void) {
        handlers[event] = cb;
        if (event === 'data') {
          setImmediate(() => {
            handlers['data']?.(Buffer.from(`data: ${JSON.stringify(payload)}\n`));
            handlers['end']?.();
          });
        }
        return stream;
      },
      destroy() {},
    };
    return { data: stream };
  };
}

const okResult = (text: string) => ({ content: [{ type: 'text', text }] });
const errResult = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

/** The X-Google-Token header of the nth transport call. */
const tokenOfCall = (n: number) => mockPost.mock.calls[n][2].headers['X-Google-Token'];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllValidTokens.mockResolvedValue(ACCOUNTS);
  mockHasGoogleConnected.mockResolvedValue(true);
});

describe('resolveGoogleAccount', () => {
  it('no accounts + none connected → not_connected with the Settings hint', async () => {
    mockGetAllValidTokens.mockResolvedValue([]);
    mockHasGoogleConnected.mockResolvedValue(false);
    const r = await gm.resolveGoogleAccount('u1');
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
    expect((r as any).message).toContain('Settings → Integrations');
  });

  it('rows exist but every refresh failed → refresh_failed (reconnect hint), NOT not_connected', async () => {
    mockGetAllValidTokens.mockResolvedValue([]);
    mockHasGoogleConnected.mockResolvedValue(true);
    const r = await gm.resolveGoogleAccount('u1');
    expect(r).toMatchObject({ ok: false, reason: 'refresh_failed' });
    expect((r as any).message).toContain('reconnect');
  });

  it('no label → deterministic first-connected account', async () => {
    const r = await gm.resolveGoogleAccount('u1');
    expect(r).toEqual({ ok: true, token: 'tok-personal' });
  });

  it('matches the bare label case-insensitively', async () => {
    expect(await gm.resolveGoogleAccount('u1', 'work')).toEqual({ ok: true, token: 'tok-work' });
    expect(await gm.resolveGoogleAccount('u1', '  WORK ')).toEqual({ ok: true, token: 'tok-work' });
  });

  it('matches the email address', async () => {
    expect(await gm.resolveGoogleAccount('u1', 'PAUL@work.com')).toEqual({ ok: true, token: 'tok-work' });
  });

  it("matches the displayed 'Label (email)' composite (what fan-out headers show)", async () => {
    expect(await gm.resolveGoogleAccount('u1', 'Work (paul@work.com)')).toEqual({ ok: true, token: 'tok-work' });
    // Composite with a mangled label half still resolves on the email half.
    expect(await gm.resolveGoogleAccount('u1', 'wrk (paul@work.com)')).toEqual({ ok: true, token: 'tok-work' });
  });

  it('no match → label_not_found and the message LISTS the valid accounts', async () => {
    const r = await gm.resolveGoogleAccount('u1', 'Uni');
    expect(r).toMatchObject({ ok: false, reason: 'label_not_found' });
    expect((r as any).message).toContain('Personal (paul@gmail.com)');
    expect((r as any).message).toContain('Work (paul@work.com)');
  });
});

describe('labeled reads resolve the fuzzy-matched account', () => {
  it("getGmailMessage(label:'work') reads with the Work token", async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('the email')));
    const out = await gm.getGmailMessage('u1', 'm1', 'work');
    expect(out).toContain('the email');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(tokenOfCall(0)).toBe('tok-work');
  });

  it('getGmailMessage with an unknown label fails closed (no read at all)', async () => {
    const out = await gm.getGmailMessage('u1', 'm1', 'Nope');
    expect(out).toBe('');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("getSheetData(label:'paul@work.com') resolves by email", async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('r1c1')));
    const out = await gm.getSheetData('u1', 's1', 'A1:B2', 'paul@work.com');
    expect(out).toContain('r1c1');
    expect(tokenOfCall(0)).toBe('tok-work');
  });

  it("getGmailAttachment(label:'Work (paul@work.com)') resolves the composite", async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('file-bytes')));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'Work (paul@work.com)');
    expect(out).toBe('file-bytes');
    expect(tokenOfCall(0)).toBe('tok-work');
  });

  describe('gmail_get_attachment surfacing (tickets 9a818013 / a7f6c4e4, 2026-10-01)', () => {
    // Gmail rotates attachmentIds on every format=full fetch; the gmail-mcp server
    // resolves stale-but-valid IDs by downloading directly and stamps the answer.
    // The client must RETURN those answers (they are content), and only squelch the
    // two genuinely-empty markers.
    it('a server-surfaced download failure is CONTENT from the owning account, not skipped', async () => {
      const failure = 'Attachment download failed in message m1: Gmail API HTTP 404 — notFound — Requested entity was not found. The attachmentId may have expired — the message\'s current attachments are: jan.pdf (attachmentId: FRESH1)';
      // First account rejects on the message fetch (error), second owns it and surfaces the real API error.
      mockPost.mockImplementation(sseImplementation(i =>
        i === 0 ? errResult('Error: Requested entity was not found.') : okResult(failure)));
      const out = await gm.getGmailAttachment('u1', 'm1', 'STALE1');
      expect(out).toContain('Attachment download failed');
      expect(out).toContain('HTTP 404');
      expect(out).toContain('FRESH1'); // the retryable fresh IDs reach the agent
    });

    it('a stale-id-fallback resolution (extracted PDF text) passes through to the agent', async () => {
      mockPost.mockImplementation(sseImplementation(i =>
        i === 0 ? errResult('Error: Requested entity was not found.')
                : okResult('Filename: 20260130-statements-9107-.pdf\nMimeType: application/pdf\nSize: 75.8KB\nmessageId: m1\nattachmentId: STALE1\nresolvedVia: stale-id-fallback\n\n── Extracted text ──\nCHASE STATEMENT')));
      const out = await gm.getGmailAttachment('u1', 'm1', 'STALE1');
      expect(out).toContain('CHASE STATEMENT');
      expect(out).toContain('stale-id-fallback');
    });

    it('the empty markers are still squelched (no/unknown attachment on THIS account)', async () => {
      mockPost.mockImplementation(sseImplementation(i =>
        i === 0 ? okResult('Could not find that attachment in message m1. Available: x.pdf (attachmentId: a1)')
                : okResult('Message m1 has no attachments.')));
      const out = await gm.getGmailAttachment('u1', 'm1', 'a1');
      expect(out).toBe('');
    });
  });
});

describe('gmail attachment binaries become model-readable text (feedback 9abf588f)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const envelope = (filename: string, mimeType: string, payload: string) => JSON.stringify({
    filename, mimeType, size: payload.length, encoding: 'base64', base64: b64(payload),
    messageId: 'm1', attachmentId: 'a1',
  });
  const pdfEnv  = envelope('quote.pdf', 'application/pdf', 'fake-pdf-bytes');
  const docxEnv = envelope('contract.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'fake-docx-bytes');

  it('PDF envelope → extracted text via the shared extractor, no base64 leaks to the model', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult(pdfEnv)));
    mockExtractPdfText.mockResolvedValue('QUOTE TOTAL: $12,345');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockExtractPdfText).toHaveBeenCalledTimes(1);
    expect(out).toContain('Filename: quote.pdf');
    expect(out).toContain('QUOTE TOTAL: $12,345');
    expect(out).not.toContain('"base64"');
  });

  it('resolvedVia marker survives the PDF-text rebuild (tickets 9a818013/a7f6c4e4 follow-up)', async () => {
    // A rotated (stale-but-valid) attachmentId resolved server-side carries
    // resolvedVia:'stale-id-fallback' — the coding-integrations metric and the
    // agent's picture of which path served the bytes both key on this string.
    const staleEnv = JSON.stringify({
      filename: '20260130-statements-9107-.pdf', mimeType: 'application/pdf', size: 77608,
      encoding: 'base64', base64: b64('fake-pdf-bytes'), messageId: 'm1', attachmentId: 'STALE1',
      resolvedVia: 'stale-id-fallback',
    });
    mockPost.mockImplementation(sseImplementation(() => okResult(staleEnv)));
    mockExtractPdfText.mockResolvedValue('CHASE STATEMENT 77608');
    const out = await gm.getGmailAttachment('u1', 'm1', 'STALE1', undefined, 'work');
    expect(out).toContain('Resolved: stale-id-fallback');
    expect(out).toContain('CHASE STATEMENT 77608');
  });

  it('sizeAmbiguous note survives the PDF-text rebuild (same-size correlation honesty)', async () => {
    const ambEnv = JSON.stringify({
      filename: 'jan.pdf', mimeType: 'application/pdf', size: 11,
      encoding: 'base64', base64: b64('fake-pdf'), messageId: 'm1', attachmentId: 'STALE1',
      resolvedVia: 'stale-id-fallback', sizeAmbiguous: true,
      ambiguityNote: '2 attachments share this byte size (11 B) — the downloaded bytes are exactly what the requested attachmentId returned.',
    });
    mockPost.mockImplementation(sseImplementation(() => okResult(ambEnv)));
    mockExtractPdfText.mockResolvedValue('pdf text');
    const out = await gm.getGmailAttachment('u1', 'm1', 'STALE1', undefined, 'work');
    expect(out).toContain('Note: 2 attachments share this byte size');
    expect(out).toContain('pdf text');
  });

  it('an envelope with NO markers keeps the historical header shape (regression)', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult(pdfEnv)));
    mockExtractPdfText.mockResolvedValue('plain download text');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toContain('Filename: quote.pdf');
    expect(out).not.toContain('Resolved:');
    expect(out).not.toContain('Note:');
  });

  it('DOCX envelope → extracted text via mammoth', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult(docxEnv)));
    mockMammothExtract.mockResolvedValue({ value: 'Contract terms herein' });
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockMammothExtract).toHaveBeenCalledTimes(1);
    expect(out).toContain('Contract terms herein');
    expect(out).not.toContain('"base64"');
  });

  it('non-image binary → base64 envelope passes through unchanged, extractor untouched', async () => {
    const zipEnv = envelope('archive.zip', 'application/zip', 'zip-bytes');
    mockPost.mockImplementation(sseImplementation(() => okResult(zipEnv)));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toBe(zipEnv);
    expect(mockExtractPdfText).not.toHaveBeenCalled();
    expect(mockMammothExtract).not.toHaveBeenCalled();
    expect(mockDescribeImageWithVision).not.toHaveBeenCalled();
  });

  it('empty extraction (scanned PDF, OCR returned nothing) → falls back to the envelope', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult(pdfEnv)));
    mockExtractPdfText.mockResolvedValue('   ');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toBe(pdfEnv);
  });

  it('extraction throw → falls back to the envelope (extraction never hard-fails the download)', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult(pdfEnv)));
    mockExtractPdfText.mockRejectedValue(new Error('pdf exploded'));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toBe(pdfEnv);
  });

  it('plain-text attachment results pass through untouched (existing text path regression)', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('Filename: notes.txt\n\n── Content ──\nhello world')));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toContain('hello world');
    expect(mockExtractPdfText).not.toHaveBeenCalled();
  });
});

describe('gmail image attachments become model-readable descriptions (d3cfbb44)', () => {
  // IMG_0754.HEIC (a photographed CRA letter) came back as a base64 JSON
  // envelope the answering model cannot see. Images now route through the
  // shared vision hop (image-describe.ts — the Image reader seat, HEIC
  // converted to JPEG INSIDE the hop, the same one view_image and the KB
  // ingester use). Proven bytes for the magic sniff — the payload is opaque
  // to these tests (the hop is mocked), it only has to SNIFF as the format
  // the filename declares.
  const envelope = (filename: string, mimeType: string, payload: Buffer) => JSON.stringify({
    filename, mimeType, size: payload.length, encoding: 'base64', base64: payload.toString('base64'),
    messageId: 'm1', attachmentId: 'a1',
  });

  // Minimal real-format headers: PNG signature, JPEG SOI, and an ISO-BMFF
  // 'ftyp' box with an 'heic' brand (view-image.ts detectImageMime keys on
  // exactly these magic bytes).
  const PNG_BYTES  = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 7)]);
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  const HEIC_BYTES = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 7)]);

  afterEach(() => { delete process.env.GMAIL_ATTACHMENT_VISION_DISABLED; });

  it('a PNG attachment (declared image/png) → vision description, no base64 leaks to the model', async () => {
    const pngEnv = envelope('chart.png', 'image/png', PNG_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(pngEnv)));
    mockDescribeImageWithVision.mockResolvedValue('A bar chart titled Q3 revenue with three bars: 12, 34, 56.');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).toHaveBeenCalledTimes(1);
    const [buf, mime, filename] = mockDescribeImageWithVision.mock.calls[0];
    expect(buf.toString('hex')).toContain('89504e47');   // the decoded bytes, not the envelope
    expect(mime).toBe('image/png');                      // the mime the BYTES proved
    expect(filename).toBe('chart.png');
    expect(out).toContain('Filename: chart.png');
    expect(out).toContain('Q3 revenue');
    expect(out).toContain('Image description');
    expect(out).not.toContain('"base64"');
  });

  it('a JPEG attachment → vision description (the common phone-photo path)', async () => {
    const jpgEnv = envelope('photo.jpg', 'image/jpeg', JPEG_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(jpgEnv)));
    mockDescribeImageWithVision.mockResolvedValue('A photographed letter from the CRA dated 2026-09-01.');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).toHaveBeenCalledTimes(1);
    expect(mockDescribeImageWithVision.mock.calls[0][1]).toBe('image/jpeg');
    expect(out).toContain('CRA');
    expect(out).not.toContain('"base64"');
  });

  it('an HEIC attachment (the reporter IMG_0754.HEIC case) routes with the sniffed image/heic mime — the hop converts it', async () => {
    const heicEnv = envelope('IMG_0754.HEIC', 'image/heic', HEIC_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(heicEnv)));
    mockDescribeImageWithVision.mockResolvedValue('A handwritten note: "call the accountant Friday".');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).toHaveBeenCalledTimes(1);
    expect(mockDescribeImageWithVision.mock.calls[0][1]).toBe('image/heic'); // converted to JPEG INSIDE the hop
    expect(mockDescribeImageWithVision.mock.calls[0][2]).toBe('IMG_0754.HEIC');
    expect(out).toContain('IMG_0754.HEIC');
    expect(out).toContain('call the accountant');
    expect(out).not.toContain('"base64"');
  });

  it('a mislabeled HEIC (application/octet-stream, magic bytes prove the image) still routes to vision', async () => {
    // Gmail serves application/octet-stream for formats it does not know; the
    // filename + the magic sniff must carry the routing.
    const misEnv = envelope('IMG_0755.HEIC', 'application/octet-stream', HEIC_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(misEnv)));
    mockDescribeImageWithVision.mockResolvedValue('A scanned receipt for $84.20.');
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).toHaveBeenCalledTimes(1);
    expect(mockDescribeImageWithVision.mock.calls[0][1]).toBe('image/heic');
    expect(out).toContain('$84.20');
  });

  it('an image-LABELED non-image (wrong mime, no image magic) is NOT routed to the vision seat', async () => {
    const fakeEnv = envelope('logo.png', 'image/png', Buffer.from('this is really a text file, not an image'));
    mockPost.mockImplementation(sseImplementation(() => okResult(fakeEnv)));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).not.toHaveBeenCalled();
    expect(out).toBe(fakeEnv); // base64 envelope passes through unchanged (no hallucination fuel)
  });

  it('vision failure → the base64 envelope unchanged (description never hard-fails the download)', async () => {
    const pngEnv = envelope('chart.png', 'image/png', PNG_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(pngEnv)));
    mockDescribeImageWithVision.mockRejectedValue(new Error('vision seat down'));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(out).toBe(pngEnv);
  });

  it('a HUGE image (over the 6 MB cap) gets the honest too-large note — no base64 bloat, no vision call', async () => {
    const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(6 * 1024 * 1024 + 1, 9)]);
    const hugeEnv = envelope('huge.png', 'image/png', huge);
    mockPost.mockImplementation(sseImplementation(() => okResult(hugeEnv)));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).not.toHaveBeenCalled();
    expect(out).toContain('too large for the vision reader');
    expect(out).toContain('Filename: huge.png');
    expect(out).not.toContain('"base64"');
    expect(out.length).toBeLessThan(600); // a bounded note, not a 6 MB transcript blob
  });

  it('kill switch GMAIL_ATTACHMENT_VISION_DISABLED=1 restores the pre-d3cfbb44 base64 envelope', async () => {
    process.env.GMAIL_ATTACHMENT_VISION_DISABLED = '1';
    const pngEnv = envelope('chart.png', 'image/png', PNG_BYTES);
    mockPost.mockImplementation(sseImplementation(() => okResult(pngEnv)));
    const out = await gm.getGmailAttachment('u1', 'm1', 'a1', undefined, 'work');
    expect(mockDescribeImageWithVision).not.toHaveBeenCalled();
    expect(out).toBe(pngEnv);
  });

  it('resolvedVia markers survive the image-description rebuild (the stale-id-fallback contract)', async () => {
    const staleEnv = JSON.stringify({
      filename: 'IMG_0754.HEIC', mimeType: 'image/heic', size: HEIC_BYTES.length,
      encoding: 'base64', base64: HEIC_BYTES.toString('base64'), messageId: 'm1', attachmentId: 'STALE1',
      resolvedVia: 'stale-id-fallback',
    });
    mockPost.mockImplementation(sseImplementation(() => okResult(staleEnv)));
    mockDescribeImageWithVision.mockResolvedValue('A photographed letter.');
    const out = await gm.getGmailAttachment('u1', 'm1', 'STALE1', undefined, 'work');
    expect(out).toContain('Resolved: stale-id-fallback');
    expect(out).toContain('A photographed letter.');
  });
});

describe('unlabeled reads fan out across accounts', () => {
  it('getGmailMessage tries every account (IDs are account-specific): first errors, second wins', async () => {
    mockPost.mockImplementation(sseImplementation(i =>
      i === 0 ? errResult('Error: Requested entity was not found.') : okResult('found in Work')));
    const out = await gm.getGmailMessage('u1', 'm-work');
    expect(out).toContain('found in Work');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(tokenOfCall(0)).toBe('tok-personal');
    expect(tokenOfCall(1)).toBe('tok-work');
  });

  it('listDriveFiles fans out with the same section headers gmail/calendar use', async () => {
    mockPost.mockImplementation(sseImplementation(i => okResult(i === 0 ? 'personal.doc' : 'work.doc')));
    const out = await gm.listDriveFiles('u1', 'spec');
    expect(out).toContain('[Google Drive Files]');
    expect(out).toContain('--- Personal (paul@gmail.com) ---');
    expect(out).toContain('--- Work (paul@work.com) ---');
    expect(out).toContain('personal.doc');
    expect(out).toContain('work.doc');
  });

  it('listDriveFiles with a label stays single-account', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('work.doc')));
    const out = await gm.listDriveFiles('u1', 'spec', 'Work');
    expect(out).toContain('work.doc');
    expect(out).not.toContain('---'); // no fan-out headers
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(tokenOfCall(0)).toBe('tok-work');
  });

  it('getDocContent tries every account until one can read the doc', async () => {
    mockPost.mockImplementation(sseImplementation(i =>
      i === 0 ? errResult('Error: The caller does not have permission') : okResult('doc body')));
    const out = await gm.getDocContent('u1', 'd1');
    expect(out).toContain('doc body');
    expect(tokenOfCall(1)).toBe('tok-work');
  });

  it('no connected accounts → reads degrade to the empty-string contract', async () => {
    mockGetAllValidTokens.mockResolvedValue([]);
    mockHasGoogleConnected.mockResolvedValue(false);
    expect(await gm.getGmailMessage('u1', 'm1')).toBe('');
    expect(await gm.listDriveFiles('u1', 'q')).toBe('');
    expect(await gm.getDocContent('u1', 'd1')).toBe('');
    expect(await gm.getSheetData('u1', 's1')).toBe('');
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ── Failure surfacing (2026-10-04, integrations/integration-error.ts) ─────────
// A failed Gmail/Calendar/Drive read used to be DROPPED by the fan-out filter,
// so the coding executor answered "No Gmail messages matched that query in any
// connected account" — a revoked token dressed as an empty inbox.
describe('failed reads surface ONE readable line per account', () => {
  const AUTH = 'Error: Request had invalid authentication credentials. Expected OAuth 2 access token.';

  it('a Google 401 on every account → the reconnect line per account (never "" / "no messages")', async () => {
    mockPost.mockImplementation(sseImplementation(() => errResult(AUTH)));
    const out = await gm.getGmailMessages('u1', 'from:bob');
    expect(out).toContain('--- Personal (paul@gmail.com) ---\nGoogle gmail list messages call was rejected by Google (Request had invalid authentication credentials.');
    expect(out).toContain('the Google connection needs re-authorizing: Account → Integrations → Google → reconnect that account');
    expect(out).toContain('--- Work (paul@work.com) ---');
  });

  it('one account failing (Google 5xx) rides under the other account\'s results', async () => {
    mockPost.mockImplementation(sseImplementation(i => (i === 0 ? okResult('📅 Standup') : errResult('Error: Backend Error'))));
    const out = await gm.getCalendarEvents('u1');
    expect(out).toContain('[Google Calendar Events]');
    expect(out).toContain('--- Personal (paul@gmail.com) ---\n📅 Standup');
    expect(out).toContain("--- Work (paul@work.com) ---\nGoogle calendar list events call failed on Google's side (Backend Error) — Google is unavailable right now; try again later.");
  });

  it('the google-mcp CONTAINER failing is a platform-side line, never "reconnect"', async () => {
    mockGetAllValidTokens.mockResolvedValue([ACCOUNTS[0]]);
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    const out = await gm.listDriveFiles('u1', 'spec');
    expect(out).toBe("Google drive list files call failed: Digby's google-mcp service did not answer (HTTP 503) — a platform-side outage, not the user's Google connection (reconnecting will not help); try again shortly.");
  });

  it('kill switch INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the empty string', async () => {
    mockPost.mockImplementation(sseImplementation(() => errResult(AUTH)));
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    try {
      expect(await gm.getGmailMessages('u1', 'q')).toBe('');
      expect(await gm.getDocContent('u1', 'd1')).toBe('');
      mockPost.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 503 } }));
      expect(await gm.listDriveFiles('u1', 'q')).toBe('');
    } finally {
      delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
    }
  });

  it('an empty-but-successful answer still reads as the MCP\'s own empty text', async () => {
    mockPost.mockImplementation(sseImplementation(() => okResult('No messages found.')));
    const out = await gm.getGmailMessages('u1', 'from:nobody');
    expect(out).toContain('No messages found.');
    expect(out).not.toContain('rejected');
  });

  it('try-every-account reads: a per-account miss stays a miss; an auth failure on the account that could hold it surfaces', async () => {
    mockPost.mockImplementation(sseImplementation(() => errResult('Error: Requested entity was not found.')));
    expect(await gm.getGmailMessage('u1', 'm1')).toBe(''); // genuinely not found anywhere → executor's "No Gmail message with that ID"
    mockPost.mockImplementation(sseImplementation(i => (i === 0 ? errResult('Error: The caller does not have permission') : errResult(AUTH))));
    expect(await gm.getDocContent('u1', 'd1')).toMatch(/^Google docs read document call was rejected by Google \(Request had invalid authentication credentials/);
  });

  it('a labeled read surfaces its account\'s failure', async () => {
    mockPost.mockImplementation(sseImplementation(() => errResult('Error: Quota exceeded for quota metric \'Queries\'')));
    expect(await gm.getSheetData('u1', 's1', 'A1', 'work')).toMatch(/^Google sheets read data call was rate-limited by Google \(Quota exceeded/);
  });

  // WRITES are pinned unchanged in google-writes.test.ts (a dead connector → the no_result envelope).
});
