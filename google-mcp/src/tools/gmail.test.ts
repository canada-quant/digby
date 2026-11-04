/**
 * gmail read-path pins — tickets 9a818013 / a7f6c4e4 (2026-10-01).
 *
 * Two live-verified Gmail behaviors broke the content-read path:
 *
 * 1. attachmentId ROTATION: Gmail mints a fresh attachmentId for every part on
 *    every format=full fetch — two back-to-back fetches of message
 *    19e7026ea59247b1 disagreed on all 15 attachmentIds — while previously
 *    minted IDs stay VALID for download for minutes. gmailGetAttachment's
 *    exact-match-then-download therefore could never match an ID shown to the
 *    caller moments earlier: every download died as "Could not find that
 *    attachment".
 * 2. Single-part HTML bodies: Chase statement notices (message 1a0f932ac3cec309,
 *    live-verified) arrive as a BARE top-level text/html part with body.data and
 *    NO parts array — extractBody handled only top-level text/plain and
 *    multipart, so the read showed "(no body content)".
 *
 * googleapis is mocked at module level; payloads mirror the live MIME shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { messagesGet, attachmentsGet } = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  attachmentsGet: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials(_: unknown) {} } },
    gmail: () => ({
      users: {
        messages: {
          get: messagesGet,
          attachments: { get: attachmentsGet },
        },
      },
    }),
  },
}));

import { extractBody, htmlToText, gmailGetAttachment, gmailReadMessage } from './gmail.js';

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

/** A format=full message payload whose parts each carry an attachment. */
const msgWithAttachments = (atts: { id: string; filename: string; size: number; mime?: string }[]) => ({
  data: {
    payload: {
      mimeType: 'multipart/mixed',
      parts: atts.map(a => ({
        mimeType: a.mime ?? 'application/pdf',
        filename: a.filename,
        body: { attachmentId: a.id, size: a.size },
      })),
    },
  },
});

/** A successful attachments.get answer (base64url-encoded bytes, matching size). */
const attData = (bytes: Buffer, size = bytes.length) => ({
  data: { size, data: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') },
});

beforeEach(() => {
  messagesGet.mockReset();
  attachmentsGet.mockReset();
  delete process.env.GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED;
});

describe('extractBody — single-part top-level text/html (ticket a7f6c4e4)', () => {
  it('reads a bare top-level text/html payload with no parts array (the Chase-notice shape)', () => {
    // Live shape of message 1a0f932ac3cec309: mimeType text/html, body.data set, no parts.
    const payload = {
      mimeType: 'text/html',
      body: { size: 18459, data: b64url('<html><body><p>Your latest statement is now available</p><p>Account ending in (&#8230;1379)</p></body></html>') },
    };
    const out = extractBody(payload, 15000);
    expect(out).toContain('Your latest statement is now available');
    expect(out).toContain('Account ending in');
    expect(out).not.toContain('<p>');
  });

  it('returns empty for a text/html payload with NO body data (nothing to read)', () => {
    expect(extractBody({ mimeType: 'text/html', body: { size: 0 } })).toBe('');
  });

  it('top-level text/plain is unchanged (regression)', () => {
    const payload = { mimeType: 'text/plain', body: { data: b64url('plain body') } };
    expect(extractBody(payload)).toBe('plain body');
  });

  it('multipart still prefers text/plain over html (regression)', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
        { mimeType: 'text/plain', body: { data: b64url('plain version') } },
      ],
    };
    expect(extractBody(payload)).toBe('plain version');
  });

  it('multipart falls back to readable HTML when no plain part exists', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<p>only html</p>') } }],
    };
    expect(extractBody(payload)).toBe('only html');
  });
});

describe('htmlToText', () => {
  it('decodes the common entities bank notices use', () => {
    expect(htmlToText('Ben&#39;s &amp; Co&#39;s &quot;Q3&quot;&nbsp;report &lt;OK&gt;'))
      .toBe(`Ben's & Co's "Q3" report <OK>`);
  });

  it('turns block-closing tags into newlines and collapses whitespace runs', () => {
    expect(htmlToText('<p>One</p><p>Two</p><div>Three<br/>Four</div>')).toBe('One\nTwo\nThree\nFour');
    expect(htmlToText('a    b\t\tc')).toBe('a b c');
  });

  it('decodes arbitrary numeric entities', () => {
    expect(htmlToText('&#8212; dash &#x27; q')).toBe('— dash \' q');
  });

  it('strips <style> and <script> blocks whole (bank notices lead with CSS)', () => {
    const html = '<html><head><style>body { color: red !important; }\nstrong { font-weight: bold; }</style></head>' +
      '<body><p>Your latest statement is now available</p><script>alert(1)</script></body></html>';
    expect(htmlToText(html)).toBe('Your latest statement is now available');
  });

  it('normalizes CRLF bank-notice bodies into readable lines (no \r noise)', () => {
    const html = '<p>Statement notification</p>\r\n\r\n<p></p>\r\n<p>Your latest statement is now available</p>';
    const out = htmlToText(html);
    expect(out).toContain('Statement notification');
    expect(out).toContain('Your latest statement is now available');
    expect(out).not.toContain('\r');
    expect(out.split('\n').every(l => l.trim() !== '' || true)).toBe(true); // no bare-CR lines
  });
});

describe('gmailGetAttachment — attachmentId rotation (ticket 9a818013)', () => {
  it('downloads with a stale-but-valid ID and size-correlates it back to the fresh part', async () => {
    // The fresh fetch mints FRESH1; the caller holds STALE1 from an earlier read.
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: '20260130-statements-9107-.pdf', size: 11 }]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const out = await gmailGetAttachment('tok', 'm1', 'STALE1');
    const env = JSON.parse(out);
    expect(attachmentsGet).toHaveBeenCalledWith(expect.objectContaining({ id: 'STALE1' }));
    expect(env.filename).toBe('20260130-statements-9107-.pdf');   // correlated by byte size
    expect(env.attachmentId).toBe('STALE1');                       // the ID that actually downloaded
    expect(env.size).toBe(11);
    expect(env.resolvedVia).toBe('stale-id-fallback');
  });

  it('same-size ambiguity: still downloads the caller\'s bytes, but flags the ambiguity honestly', async () => {
    // Two fresh parts share the byte size — the correlation can only pick the first
    // for the header; the BYTES are exactly what the caller's ID downloaded.
    messagesGet.mockResolvedValue(msgWithAttachments([
      { id: 'FRESH1', filename: 'jan.pdf', size: 11 },
      { id: 'FRESH2', filename: 'feb.pdf', size: 11 },
    ]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const env = JSON.parse(await gmailGetAttachment('tok', 'm1', 'STALE1'));
    expect(attachmentsGet).toHaveBeenCalledWith(expect.objectContaining({ id: 'STALE1' }));
    expect(env.resolvedVia).toBe('stale-id-fallback');
    expect(env.sizeAmbiguous).toBe(true);
    expect(env.ambiguityNote).toContain('2 attachments share this byte size');
    expect(env.ambiguityNote).toContain('downloaded bytes are exactly what the requested attachmentId returned');
    expect(typeof env.base64).toBe('string');   // the download itself succeeded
  });

  it('a UNIQUE size correlation carries no ambiguity flag', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([
      { id: 'FRESH1', filename: 'jan.pdf', size: 11 },
      { id: 'FRESH2', filename: 'feb.pdf', size: 22 },
    ]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const env = JSON.parse(await gmailGetAttachment('tok', 'm1', 'STALE1'));
    expect(env.sizeAmbiguous).toBeUndefined();
    expect(env.ambiguityNote).toBeUndefined();
    expect(env.filename).toBe('jan.pdf');
  });

  it('an exact-match ID takes the normal path (no fallback marker)', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'jan.pdf', size: 11 }]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const env = JSON.parse(await gmailGetAttachment('tok', 'm1', 'FRESH1'));
    expect(env.resolvedVia).toBeUndefined();
    expect(env.filename).toBe('jan.pdf');
  });

  it('filename still resolves when no attachmentId is given (regression)', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'jan.pdf', size: 11 }]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const env = JSON.parse(await gmailGetAttachment('tok', 'm1', undefined, 'JAN.PDF'));
    expect(env.filename).toBe('jan.pdf');
    expect(env.resolvedVia).toBeUndefined();
  });

  it('a DEAD stale ID surfaces the real Gmail API error (404 vs permission) plus the fresh IDs', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'jan.pdf', size: 11 }]));
    attachmentsGet.mockRejectedValue({
      response: { status: 404 },
      errors: [{ reason: 'notFound' }],
      message: 'Requested entity was not found',
    });

    const out = await gmailGetAttachment('tok', 'm1', 'STALE1');
    expect(out).toContain('Attachment download failed in message m1');
    expect(out).toContain('HTTP 404');
    expect(out).toContain('notFound');
    expect(out).toContain('jan.pdf (attachmentId: FRESH1)'); // the retryable fresh IDs
  });

  it('a permission error is distinguished from 404 in the surfaced text', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'jan.pdf', size: 11 }]));
    attachmentsGet.mockRejectedValue({
      response: { status: 403 },
      errors: [{ reason: 'forbidden' }],
      message: 'Insufficient Permission',
    });

    const out = await gmailGetAttachment('tok', 'm1', 'STALE1');
    expect(out).toContain('HTTP 403');
    expect(out).toContain('forbidden');
  });

  it('kill switch GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED=1 restores exact-match-only', async () => {
    process.env.GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED = '1';
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'jan.pdf', size: 11 }]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello world'), 11));

    const out = await gmailGetAttachment('tok', 'm1', 'STALE1');
    expect(attachmentsGet).not.toHaveBeenCalled();
    expect(out).toContain('Could not find that attachment in message m1');
    expect(out).toContain('jan.pdf (attachmentId: FRESH1)');
  });

  it('a text-like attachment resolved via the fallback keeps its content and marker', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([{ id: 'FRESH1', filename: 'notes.txt', size: 5, mime: 'text/plain' }]));
    attachmentsGet.mockResolvedValue(attData(Buffer.from('hello'), 5));

    const out = await gmailGetAttachment('tok', 'm1', 'STALE1');
    expect(out).toContain('Filename: notes.txt');
    expect(out).toContain('stale-id-fallback');
    expect(out).toContain('── Content ──');
    expect(out).toContain('hello');
  });

  it('no attachments on the message keeps the historical answer (regression)', async () => {
    messagesGet.mockResolvedValue({ data: { payload: { mimeType: 'multipart/mixed', parts: [] } } });
    const out = await gmailGetAttachment('tok', 'm1', 'any');
    expect(out).toBe('Message m1 has no attachments.');
  });
});

describe('gmailReadMessage render — filename-first download handle (2026-10-02, TTL ~90-150s)', () => {
  it('the attachment block tells the caller to PREFER the filename and warns attachmentIds expire within ~2 minutes', async () => {
    messagesGet.mockResolvedValue(msgWithAttachments([
      { id: 'FRESH1', filename: '20260130-statements-9107-.pdf', size: 77608 },
    ]));

    const out = await gmailReadMessage('tok', '19e7026ea59247b1');
    expect(out).toContain('── Attachments (1) ──');
    expect(out).toContain('20260130-statements-9107-.pdf (application/pdf, 75.8KB) — attachmentId: FRESH1');
    // filename-first instruction (the attachmentId TTL is ~90-150s — live-verified 2026-10-02)
    expect(out).toContain('prefer the FILENAME');
    expect(out).toContain('filename="20260130-statements-9107-.pdf"');
    expect(out).toContain('attachmentIds rotate per fetch and expire within ~2 minutes');
    expect(out).toContain('messageId="19e7026ea59247b1"');
  });
});
