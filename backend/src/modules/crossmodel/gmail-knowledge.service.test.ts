/**
 * Gmail attachments → project knowledge base (ticket 99145890) — pins the
 * ingestion service's contract:
 *
 *  1. DEDUP BEFORE FETCH — the ticket's explicit ask: a re-ingest of the same
 *     (messageId, filename) answers `duplicate` WITHOUT calling Gmail (the
 *     dedup check runs before the fetch, so a repeat add is one indexed query).
 *  2. The gmail://<messageId>/<filename> dedup key lands in sourceUrl with
 *     source 'gmail_attachment' — one Gmail attachment = one KB doc.
 *  3. Extraction routes images → the shared vision hop (describeImageForKnowledgeBase)
 *     and documents → extractTextFromBuffer — the SAME pipeline as add_knowledge_file
 *     and the REST upload (the 99145890 ask: "through the existing extractors").
 *  4. A failed prior ingestion (error doc) is REPLACED and retried — a transient
 *     vision failure must not permanently pin a dead row against the key.
 *  5. processDocument fires (background chunking/embedding) with the extracted text.
 *  6. The project cap refuses a 200-doc project.
 *  7. The raw pass-through: the auto-ingest hook's pre-fetched envelope is used,
 *     no second fetch.
 *  8. autoIngestGmailAttachmentIfEnabled gates on the project setting (default OFF).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// account-tools (KNOWLEDGE_CAPS) → platform.service → middleware/error-handler →
// config/env, which zod-parses env and process.exit(1)s in jest workers without
// it — mock the boundary (the coding-integrations.test.ts pattern).
jest.mock('../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

const prismaMock = {
  projectDocument: {
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(), get: jest.fn(), del: jest.fn() } }));

jest.mock('./google/google-mcp', () => ({
  fetchGmailAttachmentRaw: jest.fn(),
}));

jest.mock('./documents.controller', () => ({
  describeImageForKnowledgeBase: jest.fn(),
}));

jest.mock('./ingestion.service', () => ({
  extractTextFromBuffer: jest.fn(),
  processDocument: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./langgraph/memory.graph', () => ({
  getProjectSettings: jest.fn().mockResolvedValue({}),
}));

import { ingestGmailAttachment, autoIngestGmailAttachmentIfEnabled, gmailAttachmentDedupKey } from './gmail-knowledge.service';
import { fetchGmailAttachmentRaw } from './google/google-mcp';
import { describeImageForKnowledgeBase } from './documents.controller';
import { extractTextFromBuffer, processDocument } from './ingestion.service';
import prisma from '../../config/database';

const asMock = (f: unknown) => f as jest.Mock;

const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({
  filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1024,
  encoding: 'base64', base64: Buffer.from('pdf-bytes').toString('base64'),
  messageId: 'msg-1', attachmentId: 'att-1', ...over,
});

const BASE = { projectId: 'p1', userId: 'u1', messageId: 'msg-1', filename: 'invoice.pdf', sessionId: 's1' };

beforeEach(() => {
  jest.clearAllMocks();
  asMock(prisma.projectDocument.findFirst).mockResolvedValue(null);
  asMock(prisma.projectDocument.count).mockResolvedValue(3);
  asMock(fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: envelope(), envelope: true });
  asMock(extractTextFromBuffer).mockResolvedValue('extracted text');
  asMock(describeImageForKnowledgeBase).mockResolvedValue('[IMAGE: x]\n\na chart');
  asMock(processDocument).mockResolvedValue(undefined);
});

describe('gmailAttachmentDedupKey', () => {
  it('is gmail://<messageId>/<filename> — case-INSENSITIVE (gmail-mcp resolves by lowercase filename) and URI-encoded (F4/F11)', () => {
    expect(gmailAttachmentDedupKey('m1', 'a.pdf')).toBe('gmail://m1/a.pdf');
    // case variants of ONE attachment share one key (review F4)
    expect(gmailAttachmentDedupKey('m1', 'Invoice.PDF')).toBe(gmailAttachmentDedupKey('m1', 'invoice.pdf'));
    // a '/' in a filename must not blur the key's structure (F11)
    expect(gmailAttachmentDedupKey('m1', 'x/y.pdf')).not.toBe(gmailAttachmentDedupKey('m1/x', 'y.pdf'));
  });
});

describe('ingestGmailAttachment', () => {
  it('creates a gmail_attachment doc with the dedup key in sourceUrl and fires processDocument with the extracted text', async () => {
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd1' });
    const r = await ingestGmailAttachment(BASE);
    expect(r).toMatchObject({ outcome: 'created', documentId: 'd1', name: 'invoice.pdf', charCount: 14, status: 'processing' });
    expect(asMock(prisma.projectDocument.create).mock.calls[0][0].data).toMatchObject({
      projectId: 'p1', userId: 'u1', name: 'invoice.pdf', mimeType: 'application/pdf',
      source: 'gmail_attachment', sourceUrl: 'gmail://msg-1/invoice.pdf', status: 'processing', charCount: 14,
    });
    // the SAME download path gmail_get_attachment uses, resolved by filename
    expect(fetchGmailAttachmentRaw).toHaveBeenCalledWith('u1', 'msg-1', undefined, 'invoice.pdf', undefined);
    // documents route through the shared extractor
    expect(extractTextFromBuffer).toHaveBeenCalled();
    expect(processDocument).toHaveBeenCalledWith('d1', 'extracted text');
  });

  it('routes images through the shared vision hop (describeImageForKnowledgeBase), not the text extractor', async () => {
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd2' });
    asMock(fetchGmailAttachmentRaw).mockResolvedValue({
      ok: true, envelope: true,
      result: envelope({ filename: 'photo.heic', mimeType: 'image/heic' }),
    });
    await ingestGmailAttachment({ ...BASE, filename: 'photo.heic' });
    expect(describeImageForKnowledgeBase).toHaveBeenCalledWith(expect.any(Buffer), 'image/heic', 'photo.heic');
    expect(extractTextFromBuffer).not.toHaveBeenCalled();
  });

  it('DEDUP BEFORE FETCH: an existing non-error doc for the key answers duplicate with NO Gmail call', async () => {
    asMock(prisma.projectDocument.findFirst).mockResolvedValue({ id: 'd1', name: 'invoice.pdf', status: 'ready', userId: 'u1' });
    const r = await ingestGmailAttachment(BASE);
    expect(r).toEqual({ outcome: 'duplicate', documentId: 'd1', name: 'invoice.pdf', status: 'ready' });
    expect(fetchGmailAttachmentRaw).not.toHaveBeenCalled();
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('REPLACES an error doc: a prior failed ingestion is deleted (chunks cascade) and re-ingested fresh', async () => {
    asMock(prisma.projectDocument.findFirst).mockResolvedValue({ id: 'd-dead', name: 'invoice.pdf', status: 'error', userId: 'u1' });
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd-new' });
    const r = await ingestGmailAttachment(BASE);
    expect(prisma.projectDocument.delete).toHaveBeenCalledWith({ where: { id: 'd-dead' } });
    expect(r).toMatchObject({ outcome: 'created', documentId: 'd-new' });
    expect(processDocument).toHaveBeenCalledWith('d-new', 'extracted text');
  });

  it('records a failed extraction as an ERROR doc (no processDocument), not a thrown error', async () => {
    asMock(extractTextFromBuffer).mockRejectedValue(new Error('pdf exploded'));
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd3' });
    const r = await ingestGmailAttachment(BASE);
    expect(r).toMatchObject({ outcome: 'created', documentId: 'd3', status: 'error' });
    expect(asMock(prisma.projectDocument.create).mock.calls[0][0].data).toMatchObject({
      status: 'error', errorMsg: 'pdf exploded',
    });
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('refuses when the project is at the 200-doc cap (no fetch)', async () => {
    asMock(prisma.projectDocument.count).mockResolvedValue(200);
    const r = await ingestGmailAttachment(BASE);
    expect(r).toMatchObject({ outcome: 'error', reason: 'project_full' });
    expect(fetchGmailAttachmentRaw).not.toHaveBeenCalled();
  });

  it('answers not_found when no connected account has the message', async () => {
    asMock(fetchGmailAttachmentRaw).mockResolvedValue({ ok: false, result: '', envelope: false });
    const r = await ingestGmailAttachment(BASE);
    expect(r).toMatchObject({ outcome: 'error', reason: 'not_found' });
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
  });

  it('answers too_large past the 30 MB cap', async () => {
    const big = Buffer.alloc(30 * 1024 * 1024 + 1);
    asMock(fetchGmailAttachmentRaw).mockResolvedValue({
      ok: true, envelope: true,
      result: envelope({ base64: big.toString('base64') }),
    });
    const r = await ingestGmailAttachment(BASE);
    expect(r).toMatchObject({ outcome: 'error', reason: 'too_large' });
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
  });

  it('requires both messageId and filename', async () => {
    await expect(ingestGmailAttachment({ ...BASE, filename: ' ' })).resolves.toMatchObject({ outcome: 'error', reason: 'invalid' });
    await expect(ingestGmailAttachment({ ...BASE, messageId: '' })).resolves.toMatchObject({ outcome: 'error', reason: 'invalid' });
  });

  it('uses the pre-fetched raw envelope (the auto-ingest hook path — ONE fetch, not two)', async () => {
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd4' });
    const raw = { ok: true as const, result: envelope({ filename: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), envelope: true };
    const r = await ingestGmailAttachment({ ...BASE, filename: 'report.docx', raw });
    expect(r).toMatchObject({ outcome: 'created', documentId: 'd4' });
    expect(fetchGmailAttachmentRaw).not.toHaveBeenCalled();
    expect(asMock(prisma.projectDocument.create).mock.calls[0][0].data).toMatchObject({
      sourceUrl: 'gmail://msg-1/report.docx',
    });
  });
});

describe('autoIngestGmailAttachmentIfEnabled', () => {
  const { getProjectSettings } = jest.requireMock('./langgraph/memory.graph') as any;

  it('is a no-op when the project setting is off (the default)', async () => {
    getProjectSettings.mockResolvedValue({});
    await autoIngestGmailAttachmentIfEnabled({ projectId: 'p1', userId: 'u1', messageId: 'm1', filename: 'a.pdf' });
    expect(fetchGmailAttachmentRaw).not.toHaveBeenCalled();
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
  });

  it('ingests when the setting is ON, reusing the passed raw fetch (ONE download, not two)', async () => {
    getProjectSettings.mockResolvedValue({ autoIngestGmailAttachments: true });
    asMock(prisma.projectDocument.create).mockResolvedValue({ id: 'd1' });
    const raw = { ok: true as const, result: envelope(), envelope: true };
    await autoIngestGmailAttachmentIfEnabled({ projectId: 'p1', userId: 'u1', messageId: 'msg-1', filename: 'invoice.pdf', sessionId: 's1', raw });
    expect(getProjectSettings).toHaveBeenCalledWith('p1');
    expect(fetchGmailAttachmentRaw).not.toHaveBeenCalled(); // raw reused
    expect(prisma.projectDocument.create).toHaveBeenCalledTimes(1);
    expect(asMock(prisma.projectDocument.create).mock.calls[0][0].data).toMatchObject({
      projectId: 'p1', source: 'gmail_attachment', sourceUrl: 'gmail://msg-1/invoice.pdf',
    });
  });

  it("guards the 'chat' sentinel (ungrouped chats have no project KB — no dangling-FK create)", async () => {
    getProjectSettings.mockResolvedValue({ autoIngestGmailAttachments: true });
    await autoIngestGmailAttachmentIfEnabled({ projectId: 'chat', userId: 'u1', messageId: 'm1', filename: 'a.pdf' });
    expect(getProjectSettings).not.toHaveBeenCalled();
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
  });

  it('never throws (best-effort): a settings-read failure is logged, not propagated', async () => {
    getProjectSettings.mockRejectedValue(new Error('db down'));
    await expect(autoIngestGmailAttachmentIfEnabled({ projectId: 'p1', userId: 'u1', messageId: 'm1', filename: 'a.pdf' }))
      .resolves.toBeUndefined();
    expect(prisma.projectDocument.create).not.toHaveBeenCalled();
  });
});
