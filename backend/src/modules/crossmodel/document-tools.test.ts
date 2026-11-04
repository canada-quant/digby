/**
 * Document tools in tool-executor — create_document / read_document /
 * update_document / list_files / fill_pdf_form (the per-user GeneratedFile
 * pipeline). Boundaries mocked per repo convention: config/database (prisma),
 * upload.controller (loadAttachment), and mcp-search + the coding pipes (their
 * import graphs reach config/env / redis). document-generator runs REAL (pure
 * JS), so create/fill exercise actual generation end to end.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  generatedFile: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(), // per-user storage quota (count + sum(size))
  },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
  // Chat-attribution ownership check (owner 2026-09-22): a chat-less run may
  // name only one of the user's OWN chats — default: not owned.
  crossModelChat: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));

jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// platform.service — read_document's knowledge-doc path authorizes PROJECT access
// through getProjectAccess (ticket b62927fb). Default: no access; tests opt in.
const mockGetProjectAccess: jest.Mock = jest.fn(async () => null);
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  getProjectAccess: (...a: any[]) => mockGetProjectAccess(...a),
}));

import { createHash } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { ToolCache } from './tool-executor';

const SIGN_IN_MSG = 'Document tools need a signed-in account. Ask the user to sign in, then try again.';

/** Real AcroForm PDF (text field + checkbox) as base64 — built once for all fill tests. */
let formPdfBase64: string;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const tf = form.createTextField('first_name');
  tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  formPdfBase64 = Buffer.from(await doc.save()).toString('base64');
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: an account far below both quota caps (tests override per-case).
  mockPrisma.generatedFile.aggregate.mockResolvedValue({
    _count: { _all: 1 },
    _sum: { size: 1024 },
  });
});

describe('anonymous access', () => {
  it.each(['create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form'])(
    '%s → sign-in message, no prisma/attachment work',
    async (tool) => {
      const cache = new ToolCache(null);
      const out = await cache.getOrExecute(tool, {
        filename: 'a.txt', content: 'x', fileId: 'f1', uploadId: 'u1', fields: { a: '1' },
      });
      expect(out).toBe(SIGN_IN_MSG);
      expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
      expect(mockPrisma.generatedFile.findFirst).not.toHaveBeenCalled();
      expect(mockLoadAttachment).not.toHaveBeenCalled();
    }
  );
});

describe('create_document', () => {
  it('needs a filename', async () => {
    const out = await new ToolCache('u1').getOrExecute('create_document', { content: 'x' });
    expect(out).toContain('create_document needs a `filename`');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('txt: generates for real, persists a GeneratedFile, returns id + download path', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-123' });
    // A chat-less run naming the user's OWN chat 'c9' — ownership verified.
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'c9' });
    const out = await new ToolCache('u1').getOrExecute('create_document', {
      filename: 'notes.txt', content: 'hello', chatId: 'c9',
    });

    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.generatedFile.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      userId: 'u1',
      chatId: 'c9',
      filename: 'notes.txt',
      format: 'txt',
      mimeType: 'text/plain',
      size: 5,
      textContent: 'hello',
    });
    expect(Buffer.from(arg.data.data, 'base64').toString('utf8')).toBe('hello');

    expect(out).toContain('Created notes.txt (txt, 5 bytes)');
    expect(out).toContain('File id: file-123');
    expect(out).toContain('/api/crossmodel/generated-files/file-123/download');
  });

  it('xlsx via sheets: persists the real workbook bytes', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-x' });
    const out = await new ToolCache('u1').getOrExecute('create_document', {
      filename: 'data.xlsx',
      sheets: [{ name: 'S', rows: [['a', 1]] }],
    });
    const arg = mockPrisma.generatedFile.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      userId: 'u1',
      filename: 'data.xlsx',
      format: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const buf = Buffer.from(arg.data.data, 'base64');
    expect(buf[0]).toBe(0x50); // xlsx is a zip
    expect(buf[1]).toBe(0x4b);
    expect(arg.data.size).toBe(buf.length);
    expect(out).toContain('File id: file-x');
  });

  it('generator errors surface as "Tool call failed" (normalizeSheets validation)', async () => {
    const out = await new ToolCache('u1').getOrExecute('create_document', {
      filename: 'data.xlsx', sheets: 'nope',
    });
    expect(out).toContain('Tool call failed:');
    expect(out).toContain('`sheets` must be an array');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  // chatId attribution (ticket 8db4c18e): the chat Files sidebar filters
  // generated files by chatId, so a file created without one never appears.
  it('chatId attribution: defaults to the ToolCache chatId when the arg is absent', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-c1' });
    const out = await new ToolCache('u1', 'chat-1').getOrExecute('create_document', {
      filename: 'notes.txt', content: 'hello',
    });
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBe('chat-1');
    expect(out).toContain('File id: file-c1');
  });

  // Owner 2026-09-22 ("files from another project session are appearing in a
  // different project session's chat sidebar"): the RUN's chat always wins —
  // the model's arg used to re-home the file into another chat's sidebar.
  it('chatId attribution: an explicit args.chatId does NOT override the ToolCache chatId', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-c2' });
    await new ToolCache('u1', 'chat-1').getOrExecute('create_document', {
      filename: 'notes.txt', content: 'hello', chatId: 'chat-explicit',
    });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBe('chat-1');
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
  });

  it('chatId attribution: a chat-less run naming a chat the user does NOT own files the document unattributed', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-c4' });
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce(null);
    await new ToolCache('u1').getOrExecute('create_document', {
      filename: 'notes.txt', content: 'hello', chatId: 'someone-elses-chat',
    });
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({ where: { id: 'someone-elses-chat', userId: 'u1' }, select: { id: true } });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBeNull();
  });

  it('chatId attribution: no arg and no ToolCache chatId → null (existing behavior)', async () => {
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'file-c3' });
    await new ToolCache('u1').getOrExecute('create_document', {
      filename: 'notes.txt', content: 'hello',
    });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBeNull();
  });
});

describe('read_document', () => {
  it('needs a fileId or documentId', async () => {
    const out = await new ToolCache('u1').getOrExecute('read_document', {});
    expect(out).toContain('read_document needs a `fileId`');
  });

  it('unknown fileId → not-found message pointing at list_files', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue(null);
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'missing-1' });
    expect(mockPrisma.generatedFile.findFirst).toHaveBeenCalledWith({
      where: { id: 'missing-1', userId: 'u1' },
    });
    expect(out).toContain('No generated file with id missing-1 belongs to this user');
    expect(out).toContain('list_files');
  });

  it('existing txt file → header + stored textContent', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({
      id: 'f1', filename: 'notes.txt', format: 'txt', size: 11,
      textContent: 'hello world', data: Buffer.from('hello world').toString('base64'),
    });
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f1' });
    expect(out).toContain('[File: notes.txt — txt, 11 bytes | text: 11 chars, sha256:');
    expect(out).toContain('hello world');
  });

  it('PDF with an AcroForm surfaces the form field names for fill_pdf_form', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({
      id: 'f2', filename: 'form.pdf', format: 'pdf', size: 999,
      textContent: '', data: formPdfBase64,
    });
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f2' });
    expect(out).toContain('(no text rendering stored for this file)');
    expect(out).toContain('PDF FORM FIELDS');
    expect(out).toContain('- first_name (PDFTextField)');
  });

  it('documentId path: joins knowledge chunks; unknown documentId → not-found', async () => {
    mockPrisma.projectDocument.findFirst.mockResolvedValue({ id: 'd1', name: 'Spec Doc', userId: 'u1', projectId: 'proj-1' });
    mockPrisma.projectChunk.findMany.mockResolvedValue([{ content: 'alpha' }, { content: 'beta' }]);
    const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd1' });
    // Fetched by id alone — authorization is a separate step (uploader OR project access).
    expect(mockPrisma.projectDocument.findFirst).toHaveBeenCalledWith({
      where: { id: 'd1' },
    });
    // Uploader match short-circuits: no project-access lookup needed.
    expect(mockGetProjectAccess).not.toHaveBeenCalled();
    expect(mockPrisma.projectChunk.findMany).toHaveBeenCalledWith({
      where: { documentId: 'd1' },
      orderBy: { chunkIndex: 'asc' },
      select: { content: true }, // NO take cap — the full text feeds the stated total + sha256
    });
    expect(out).toContain('[Document: Spec Doc | text: 11 chars, sha256:');
    expect(out).toContain('alpha\n\nbeta');

    mockPrisma.projectDocument.findFirst.mockResolvedValue(null);
    const missing = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-x' });
    expect(missing).toContain('No knowledge document with id d-x belongs to this user');
  });

  // ── Paging + integrity header (ticket 5502e6ed) ─────────────────────────
  const sha256Of = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const BIG_TEXT = '0123456789'.repeat(6100); // 61,000 chars — over the 50,000 default page
  const BIG_HEADER = `[File: capture.txt — txt, 61000 bytes | text: ${BIG_TEXT.length} chars, sha256: ${sha256Of(BIG_TEXT)}]`;
  const mockBigFile = () => mockPrisma.generatedFile.findFirst.mockResolvedValue({
    id: 'f-big', filename: 'capture.txt', format: 'txt', size: 61000,
    textContent: BIG_TEXT, data: Buffer.from(BIG_TEXT).toString('base64'),
  });
  /** Assert the header line, then return the body minus the optional paging note. */
  const extractBody = (out: string, header: string): string => {
    expect(out.startsWith(`${header}\n`)).toBe(true);
    return out.slice(header.length + 1).replace(/\n\(showing chars [^\n]*\)$/, '');
  };

  it('default read: header states total + sha256; body is exactly the first 50000 chars of a >50k file', async () => {
    mockBigFile();
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big' });
    expect(out).toContain(`text: ${BIG_TEXT.length} chars, sha256:`);
    expect(out).toBe(
      `${BIG_HEADER}\n${BIG_TEXT.slice(0, 50000)}\n(showing chars 0–50000 of ${BIG_TEXT.length} — page with offset/limit)`,
    );
  });

  it('header sha256 equals the sha256 of the FULL stored text (not the returned page)', async () => {
    mockBigFile();
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', offset: 50000 });
    expect(out).toContain(`sha256: ${sha256Of(BIG_TEXT)}`);
    expect(out).not.toContain(`sha256: ${sha256Of(BIG_TEXT.slice(50000))}`);
  });

  it('offset+limit returns exactly fullText.slice(offset, offset+limit)', async () => {
    mockBigFile();
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', offset: 100, limit: 50 });
    expect(out).toBe(
      `${BIG_HEADER}\n${BIG_TEXT.slice(100, 150)}\n(showing chars 100–150 of ${BIG_TEXT.length} — page with offset/limit)`,
    );
  });

  it('two 50k pages stitch byte-exactly back to the full 61k text', async () => {
    mockBigFile();
    const page1 = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big' });
    const page2 = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', offset: 50000 });
    const body1 = extractBody(page1, BIG_HEADER);
    const body2 = extractBody(page2, BIG_HEADER);
    expect(body1).toBe(BIG_TEXT.slice(0, 50000));
    expect(body2).toBe(BIG_TEXT.slice(50000)); // final page: no paging note
    expect(body1 + body2).toBe(BIG_TEXT);
  });

  it('offset past end → header + past-end note, no body', async () => {
    mockBigFile();
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', offset: BIG_TEXT.length });
    expect(out).toBe(`${BIG_HEADER}\n(offset past end of text — total ${BIG_TEXT.length} chars, nothing at offset ${BIG_TEXT.length})`);
    expect(out).not.toContain('0123456789');

    const way = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', offset: 999999 });
    expect(way).toContain('(offset past end of text');
  });

  it.each([
    [{ offset: -1 }, 'offset must be an integer >= 0'],
    [{ offset: 1.5 }, 'offset must be an integer >= 0'],
    [{ offset: 'x' }, 'offset must be an integer >= 0'],
    [{ limit: 0 }, 'limit must be an integer between 1 and 50000'],
    [{ limit: 50001 }, 'limit must be an integer between 1 and 50000'],
    [{ limit: 'x' }, 'limit must be an integer between 1 and 50000'],
  ])('invalid paging args %o → constraint error, no prisma read', async (extra, constraint) => {
    const out = await new ToolCache('u1').getOrExecute('read_document', { fileId: 'f-big', ...extra });
    expect(out).toContain('read_document: invalid');
    expect(out).toContain(constraint);
    expect(mockPrisma.generatedFile.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.projectChunk.findMany).not.toHaveBeenCalled();
  });

  // ── Ticket b62927fb replay: project-member read access ─────────────────────
  // The reported failure: list_knowledge_documents (getProjectAccess-authorized)
  // showed a doc READY in the caller's project while read_document refused it
  // with "belongs to this user" because authorization keyed on the UPLOADER's
  // userId. Read access must follow PROJECT access, not uploader identity.
  describe('ticket b62927fb: read_document authorizes project documents by project access', () => {
    const OTHER_UPLOADED = { id: 'd-shared', name: 'allin-people.txt', userId: 'u-other', projectId: 'proj-1' };

    it('REPLAY: doc uploaded by someone else into a project the caller can access → readable (was: ownership refusal)', async () => {
      mockPrisma.projectDocument.findFirst.mockResolvedValue(OTHER_UPLOADED);
      mockPrisma.projectChunk.findMany.mockResolvedValue([{ content: 'attendee alpha' }, { content: 'attendee beta' }]);
      mockGetProjectAccess.mockResolvedValue({ project: { id: 'proj-1', name: 'ALL IN 2026' }, role: 'owner' });

      const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-shared' });
      expect(mockGetProjectAccess).toHaveBeenCalledWith('proj-1', 'u1');
      expect(out).toContain('[Document: allin-people.txt | text: 29 chars, sha256:');
      expect(out).toContain('attendee alpha\n\nattendee beta');
      expect(out).not.toContain('belongs to this user');
    });

    it('a project VIEWER (getProjectAccess role viewer) can read — same grant as list_knowledge_documents', async () => {
      mockPrisma.projectDocument.findFirst.mockResolvedValue(OTHER_UPLOADED);
      mockPrisma.projectChunk.findMany.mockResolvedValue([{ content: 'alpha' }]);
      mockGetProjectAccess.mockResolvedValue({ project: { id: 'proj-1' }, role: 'viewer' });

      const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-shared' });
      expect(out).toContain('alpha');
      expect(out).not.toContain('belongs to this user');
    });

    it('no project access → the IDENTICAL refusal as a missing doc (existence is not leaked)', async () => {
      mockPrisma.projectDocument.findFirst.mockResolvedValue(OTHER_UPLOADED);
      mockGetProjectAccess.mockResolvedValue(null); // default, made explicit

      const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-shared' });
      expect(mockGetProjectAccess).toHaveBeenCalledWith('proj-1', 'u1');
      expect(out).toContain('No knowledge document with id d-shared belongs to this user');
      expect(mockPrisma.projectChunk.findMany).not.toHaveBeenCalled();
    });

    it('ungrouped doc (projectId null) uploaded by someone else → refusal, no access lookup', async () => {
      mockPrisma.projectDocument.findFirst.mockResolvedValue({ id: 'd-solo', name: 'private.txt', userId: 'u-other', projectId: null });

      const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-solo' });
      expect(mockGetProjectAccess).not.toHaveBeenCalled();
      expect(out).toContain('No knowledge document with id d-solo belongs to this user');
      expect(mockPrisma.projectChunk.findMany).not.toHaveBeenCalled();
    });
  });

  it('knowledge doc with >40 chunks: total/hash cover ALL chunks (take:40 cap is gone) and paging reaches chunk 41+', async () => {
    // 45 chunks × 1200 chars + 44 '\n\n' joins = 54,088 chars — over the 50k
    // default page AND over the old 40-chunk cap (48,078 chars).
    const chunkContents = Array.from({ length: 45 }, (_, i) => `chunk-${String(i).padStart(4, '0')} ${'y'.repeat(1189)}`);
    const full = chunkContents.join('\n\n');
    expect(full.length).toBeGreaterThan(50000);
    mockPrisma.projectDocument.findFirst.mockResolvedValue({ id: 'd-big', name: 'Big Doc', userId: 'u1', projectId: 'proj-1' });
    mockPrisma.projectChunk.findMany.mockResolvedValue(chunkContents.map(content => ({ content })));

    const out = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-big' });
    expect(mockPrisma.projectChunk.findMany).toHaveBeenCalledWith({
      where: { documentId: 'd-big' },
      orderBy: { chunkIndex: 'asc' },
      select: { content: true }, // no take — every chunk fetched
    });
    const header = `[Document: Big Doc | text: ${full.length} chars, sha256: ${sha256Of(full)}]`;
    expect(out).toContain(header);
    expect(out).toContain('chunk-0041'); // chunk 42 starts at char 49282 — inside page 1

    const tail = await new ToolCache('u1').getOrExecute('read_document', { documentId: 'd-big', offset: 50000 });
    expect(tail).toBe(`${header}\n${full.slice(50000)}`);
    expect(tail).toContain('chunk-0044'); // final chunk reachable only past offset 52888
  });
});

describe('update_document', () => {
  it('needs a fileId', async () => {
    const out = await new ToolCache('u1').getOrExecute('update_document', { content: 'x' });
    expect(out).toContain('update_document needs a `fileId`');
  });

  it('unknown fileId → not-found message', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue(null);
    const out = await new ToolCache('u1').getOrExecute('update_document', { fileId: 'nope', content: 'x' });
    expect(out).toContain('No generated file with id nope belongs to this user');
    expect(mockPrisma.generatedFile.update).not.toHaveBeenCalled();
  });

  it('existing file → regenerates in place and confirms', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'f1', filename: 'notes.txt', format: 'txt' });
    mockPrisma.generatedFile.update.mockResolvedValue({});
    const out = await new ToolCache('u1').getOrExecute('update_document', { fileId: 'f1', content: 'new content' });

    expect(mockPrisma.generatedFile.update).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.generatedFile.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'f1' });
    expect(arg.data.textContent).toBe('new content');
    expect(arg.data.size).toBe(11);
    expect(Buffer.from(arg.data.data, 'base64').toString('utf8')).toBe('new content');

    expect(out).toContain('Updated notes.txt (txt, 11 bytes)');
    expect(out).toContain('File id: f1');
    expect(out).toContain('/api/crossmodel/generated-files/f1/download');
  });
});

describe('list_files', () => {
  it('empty account → "no files yet" message', async () => {
    mockPrisma.generatedFile.findMany.mockResolvedValue([]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([]);
    mockPrisma.chatFile.findMany.mockResolvedValue([]);
    const out = await new ToolCache('u1').getOrExecute('list_files', {});
    expect(out).toContain('The user has no files yet');
  });

  it('lists generated files and knowledge documents with their ids', async () => {
    mockPrisma.generatedFile.findMany.mockResolvedValue([
      { id: 'f1', filename: 'a.txt', format: 'txt', size: 3, createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([
      { id: 'd1', name: 'Spec', mimeType: 'application/pdf', status: 'ready', charCount: 100 },
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([]);
    const out = await new ToolCache('u1').getOrExecute('list_files', {});
    expect(out).toContain('GENERATED FILES');
    expect(out).toContain('- a.txt (txt, 3 bytes, 2026-08-01) — File id: f1');
    expect(out).toContain('UPLOADED/KNOWLEDGE DOCUMENTS');
    expect(out).toContain('- Spec (application/pdf, ready, 100 chars) — Document id: d1');
  });

  it('a chat-scoped run ALSO lists the chat’s uploads — images carry the exact inline-embed markdown (2026-08-31)', async () => {
    mockPrisma.generatedFile.findMany.mockResolvedValue([]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([]);
    mockPrisma.chatFile.findMany.mockResolvedValue([
      { id: 'cf1', filename: 'frame.png', mimeType: 'image/png', sizeBytes: 70, createdAt: new Date('2026-08-31T00:00:00Z') },
      { id: 'cf2', filename: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 500, createdAt: new Date('2026-08-31T00:00:00Z') },
    ]);
    const out = await new ToolCache('u1', 'chat-9').getOrExecute('list_files', {});
    expect(out).toContain("THIS CHAT'S UPLOADS");
    // image row → the exact embeddable form
    expect(out).toContain('![frame.png](/api/crossmodel/files/cf1/inline)');
    // non-image row → listed but NO embed form
    expect(out).toContain('notes.docx');
    expect(out).not.toContain('![notes.docx]');
    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: 'chat-9' } }));
  });

  it('a chat-LESS run skips the chatFile query entirely', async () => {
    mockPrisma.generatedFile.findMany.mockResolvedValue([
      { id: 'f1', filename: 'a.txt', format: 'txt', size: 3, createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    mockPrisma.projectDocument.findMany.mockResolvedValue([]);
    const out = await new ToolCache('u1').getOrExecute('list_files', {});
    expect(out).toContain('(none yet — files the user attaches to messages appear here)');
    expect(mockPrisma.chatFile.findMany).not.toHaveBeenCalled();
  });
});

describe('fill_pdf_form', () => {
  it('needs a non-empty fields object', async () => {
    const cache = new ToolCache('u1');
    expect(await cache.getOrExecute('fill_pdf_form', { uploadId: 'up-1' }))
      .toContain('fill_pdf_form needs `fields`');
    expect(await new ToolCache('u1').getOrExecute('fill_pdf_form', { uploadId: 'up-1', fields: {} }))
      .toContain('fill_pdf_form needs `fields`');
    expect(await new ToolCache('u1').getOrExecute('fill_pdf_form', { uploadId: 'up-1', fields: ['a'] }))
      .toContain('fill_pdf_form needs `fields`');
  });

  it('needs a source PDF when neither fileId nor uploadId is given', async () => {
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', { fields: { first_name: 'Ada' } });
    expect(out).toContain('fill_pdf_form needs a source PDF');
    expect(mockLoadAttachment).not.toHaveBeenCalled();
  });

  it('uploadId path: fills the attached form, saves <base>-filled.pdf, reports unknown fields', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'pdf', filename: 'form.pdf', base64: formPdfBase64 });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-1' });

    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-1',
      fields: { first_name: 'Ada', unknown_field: 'x' },
    });

    expect(mockLoadAttachment).toHaveBeenCalledWith('up-1');
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.generatedFile.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      userId: 'u1',
      filename: 'form-filled.pdf',
      format: 'pdf',
      mimeType: 'application/pdf',
    });
    expect(arg.data.size).toBeGreaterThan(0);
    expect(arg.data.textContent).toContain('first_name');
    // The persisted buffer is the real filled PDF.
    const saved = Buffer.from(arg.data.data, 'base64');
    expect(saved.subarray(0, 4).toString('latin1')).toBe('%PDF');

    expect(out).toContain('Filled PDF saved as form-filled.pdf');
    expect(out).toContain('File id: filled-1');
    expect(out).toContain('/api/crossmodel/generated-files/filled-1/download');
    expect(out).toContain('did NOT match the form and were NOT set: unknown_field');
    expect(out).toContain('- first_name (PDFTextField)');
  });

  it('uploadId: expired/missing upload → re-attach message', async () => {
    mockLoadAttachment.mockResolvedValue(null);
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-gone', fields: { first_name: 'Ada' },
    });
    expect(out).toContain('Upload up-gone expired or was not found');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('uploadId: non-PDF attachment → type error', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'image', filename: 'pic.png' });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-2', fields: { first_name: 'Ada' },
    });
    expect(out).toContain('Upload up-2 is a image, not a PDF');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('fileId path: fills a generated PDF the user owns', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue({
      id: 'f9', filename: 'template.pdf', format: 'pdf', data: formPdfBase64,
    });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-9' });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      fileId: 'f9', fields: { first_name: 'Grace' },
    });
    expect(mockPrisma.generatedFile.findFirst).toHaveBeenCalledWith({
      where: { id: 'f9', userId: 'u1' },
    });
    expect(out).toContain('Filled PDF saved as template-filled.pdf');
    expect(out).toContain('File id: filled-9');
    expect(out).not.toContain('did NOT match');
  });

  it('chatId attribution (ticket 8db4c18e): the filled copy inherits the ToolCache chatId', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'pdf', filename: 'form.pdf', base64: formPdfBase64 });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-c' });
    await new ToolCache('u1', 'chat-9').getOrExecute('fill_pdf_form', {
      uploadId: 'up-1', fields: { first_name: 'Ada' },
    });
    expect(mockPrisma.generatedFile.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBe('chat-9');
  });

  it('chatId attribution: no ToolCache chatId → null (existing behavior)', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'pdf', filename: 'form.pdf', base64: formPdfBase64 });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-n' });
    await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-1', fields: { first_name: 'Ada' },
    });
    expect(mockPrisma.generatedFile.create.mock.calls[0][0].data.chatId).toBeNull();
  });

  it('fileId: unknown id → not-found; non-PDF file → type error', async () => {
    mockPrisma.generatedFile.findFirst.mockResolvedValue(null);
    const missing = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      fileId: 'f-x', fields: { a: '1' },
    });
    expect(missing).toContain('No generated file with id f-x belongs to this user');

    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'f2', filename: 'notes.txt', format: 'txt' });
    const wrongType = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      fileId: 'f2', fields: { a: '1' },
    });
    expect(wrongType).toContain('File notes.txt is a txt, not a PDF');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });
});

// ── Review hardening (adversarial review of #345) ─────────────────────────────

describe('per-user storage quota (M1)', () => {
  it('create_document: blocked at the 100-row cap, pointing at the Files page (no delete tool)', async () => {
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { size: 1024 } });
    const out = await new ToolCache('u1').getOrExecute('create_document', { filename: 'a.txt', content: 'x' });
    expect(out).toContain('Storage quota reached');
    expect(out).toContain('100 generated files');
    expect(out).toContain('no delete tool');
    expect(out).toContain('/files');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('create_document: blocked when the ~200MB stored-payload cap would be exceeded', async () => {
    // 160MB raw ≈ 213MB stored base64 — over the cap before the new file even lands.
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 5 }, _sum: { size: 160 * 1024 * 1024 } });
    const out = await new ToolCache('u1').getOrExecute('create_document', { filename: 'a.txt', content: 'x' });
    expect(out).toContain('Storage quota reached');
    expect(out).toContain('200MB storage cap');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('fill_pdf_form: the filled copy is a NEW row — blocked at the row cap before persisting', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'pdf', filename: 'form.pdf', base64: formPdfBase64 });
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { size: 0 } });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-1', fields: { first_name: 'Ada' },
    });
    expect(out).toContain('Storage quota reached');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it('update_document: replaces a row in place — NOT blocked by the row cap', async () => {
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { size: 1024 } });
    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'f1', filename: 'notes.txt', format: 'txt', size: 5 });
    mockPrisma.generatedFile.update.mockResolvedValue({});
    const out = await new ToolCache('u1').getOrExecute('update_document', { fileId: 'f1', content: 'new content' });
    expect(out).toContain('Updated notes.txt');
    expect(mockPrisma.generatedFile.update).toHaveBeenCalledTimes(1);
  });

  it('update_document: byte cap still applies (net of the bytes being replaced)', async () => {
    // 150MB raw = exactly the 200MB base64 cap; replacing a 0-byte file with
    // any content pushes past it.
    mockPrisma.generatedFile.aggregate.mockResolvedValue({ _count: { _all: 5 }, _sum: { size: 150 * 1024 * 1024 } });
    mockPrisma.generatedFile.findFirst.mockResolvedValue({ id: 'f1', filename: 'notes.txt', format: 'txt', size: 0 });
    const out = await new ToolCache('u1').getOrExecute('update_document', { fileId: 'f1', content: 'new content' });
    expect(out).toContain('Storage quota reached');
    expect(mockPrisma.generatedFile.update).not.toHaveBeenCalled();
  });
});

describe('uploadId ownership binding (M2)', () => {
  it('rejects an upload stashed by a DIFFERENT user with the uniform not-found message (no existence leak)', async () => {
    mockLoadAttachment.mockResolvedValue({
      type: 'pdf', filename: 'form.pdf', base64: formPdfBase64, ownerUserId: 'someone-else',
    });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-theirs', fields: { first_name: 'Ada' },
    });
    // EXACTLY the expired/missing message — a probing model cannot distinguish
    // "someone else's upload" from "no such upload".
    expect(out).toContain('Upload up-theirs expired or was not found');
    expect(out).not.toContain('someone-else');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });

  it("accepts the requesting user's own upload (ownerUserId matches)", async () => {
    mockLoadAttachment.mockResolvedValue({
      type: 'pdf', filename: 'form.pdf', base64: formPdfBase64, ownerUserId: 'u1',
    });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-own' });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-mine', fields: { first_name: 'Ada' },
    });
    expect(out).toContain('Filled PDF saved as form-filled.pdf');
    expect(out).toContain('File id: filled-own');
  });

  it('accepts an ownerless upload (anonymous stash / pre-binding legacy blob) — unchanged behavior', async () => {
    mockLoadAttachment.mockResolvedValue({
      type: 'pdf', filename: 'form.pdf', base64: formPdfBase64, ownerUserId: null,
    });
    mockPrisma.generatedFile.create.mockResolvedValue({ id: 'filled-anon' });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-anon', fields: { first_name: 'Ada' },
    });
    expect(out).toContain('Filled PDF saved as form-filled.pdf');
    expect(out).toContain('File id: filled-anon');
  });
});

describe('PDF parse bounds (M3)', () => {
  it('rejects an input PDF over the 15MB form-operation cap with a clear error', async () => {
    const bigBase64 = Buffer.alloc(15 * 1024 * 1024 + 1, 0x25).toString('base64');
    mockLoadAttachment.mockResolvedValue({ type: 'pdf', filename: 'huge.pdf', base64: bigBase64 });
    const out = await new ToolCache('u1').getOrExecute('fill_pdf_form', {
      uploadId: 'up-big', fields: { a: '1' },
    });
    expect(out).toContain('Tool call failed:');
    expect(out).toContain('Input PDF too large for form operations');
    expect(mockPrisma.generatedFile.create).not.toHaveBeenCalled();
  });
});
