/**
 * Shared-chat generated images (generate_image tranche B, 2026-09-24).
 *
 * Pins, with prisma mocked at the boundary (scaffold: generated-files.inline.test.ts):
 *   payload — GET /shared/chat/:token exposes ONLY generated image parts, as a
 *     field whitelist with a token-scoped url: never tool_call / tool_result /
 *     reasoning parts, never screenshots, never base64, never the raw `parts`
 *     array, never the authed /generated-files url; `images` is absent when a
 *     message has none (unchanged serialization for chats without pictures);
 *     the endpoint's own status codes (404 / 410 / 410 / 404) are unchanged.
 *     `parts` is NEVER selected on the message read (screenshots persist there
 *     with inline base64, and this route is unauthenticated + unrate-limited):
 *     generated images come from ONE SQL projection scoped to the chat that
 *     filters type/source and strips `data` in the database, runs only after
 *     the link gate passes, and is skipped for a message-less chat.
 *   bytes — GET /shared/chat/:token/image/:fileId serves image/* inline with
 *     nosniff + PUBLIC hour caching, and answers ONE 404 to everything else:
 *     missing / inactive / expired link, coding chat, wrong owner, wrong chat,
 *     non-image (never a 415 leak), missing file.
 */

const prismaMock = {
  chatShareLink: { findUnique: jest.fn() },
  generatedFile: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
jest.mock('../../config/database', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// middleware/auth's import chain is jest-unsafe; generated-files.controller
// only needs the AuthRequest type from it.
jest.mock('../../middleware/auth', () => ({ AuthRequest: {} }));
// chat-files.controller pulls crossmodel.service + text-extract; only its
// pure one-liner is needed here.
jest.mock('./chat-files.controller', () => ({
  __esModule: true,
  mimeEssence: (m: string) => m.split(';', 1)[0].trim().toLowerCase(),
}));

import {
  getSharedChat,
  getSharedChatImage,
  sharedImagesFromParts,
  sharedChatImagePath,
  shareLinkAccess,
} from './sharing.controller';

const TOKEN = 'tok123abc';
const OWNER = 'u-owner';
const CHAT = 'chat-1';
const NOW = new Date('2026-09-24T12:00:00Z');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const IMAGE_ROW = {
  id: 'f-img', userId: OWNER, chatId: CHAT, filename: 'image-20260924-140322-a-red-fox.png', format: 'png',
  mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), textContent: '[Generated image] …',
  createdAt: NOW, updatedAt: NOW,
};

// Everything a persisted assistant transcript can hold. Sentinels are unique
// strings so a leak is caught by one JSON.stringify scan of the payload.
const GENERATED_PART = {
  type: 'image', mediaType: 'image/png', url: '/api/crossmodel/generated-files/f-img/inline',
  name: 'Generated · 1024×1024 · "a red fox"', source: 'generated', fileId: 'f-img', prompt: 'a red fox in the snow',
  ts: '2026-09-24T12:00:00.000Z',
};
const PARTS = [
  { type: 'reasoning', text: 'SENTINEL-REASONING' },
  { type: 'tool_call', name: 'web_search', args: { q: 'SENTINEL-TOOLCALL' } },
  { type: 'tool_result', name: 'web_search', text: 'SENTINEL-TOOLRESULT' },
  { type: 'text', text: 'Here is your fox.' },
  { type: 'image', mediaType: 'image/png', data: 'SENTINEL-SCREENSHOT-BYTES', name: 'Final page', source: 'browser', pageUrl: 'https://SENTINEL-PAGEURL' },
  { type: 'image', mediaType: 'image/png', data: 'SENTINEL-COMPUTER-BYTES', name: 'Final screen · Your Mac', source: 'computer', app: 'SENTINEL-APP' },
  { ...GENERATED_PART, data: 'SENTINEL-GENERATED-BYTES' }, // a live/echo part can still carry bytes
  { type: 'image', mediaType: 'image/png', data: 'SENTINEL-ATTACHMENT-BYTES' }, // plain attachment, no source
  { type: 'image', source: 'generated', mediaType: 'image/png', url: '/api/crossmodel/generated-files/SENTINEL-NOFILEID/inline' }, // no fileId → unroutable, dropped
  { type: 'subagent', text: 'SENTINEL-SUBAGENT' },
];

const linkRow = (over: any = {}) => ({
  id: 'sl1', chatId: CHAT, shareToken: TOKEN, isActive: true, expiresAt: null, createdAt: NOW,
  chat: {
    id: CHAT, userId: OWNER, title: 'Fox chat', mode: 'thinking',
    user: { name: 'Paul' }, project: null, codingState: null,
    // What the (parts-free) select returns: id + role + content + metadata +
    // createdAt. PARTS never rides this read — see sqlProjection below.
    chatMessages: [
      { id: 'm1', role: 'user', content: 'draw a fox', metadata: null, createdAt: NOW },
      { id: 'm2', role: 'assistant', content: 'Here is your fox.', metadata: { mode: 'thinking' }, createdAt: NOW },
      { id: 'm3', role: 'assistant', content: 'Plain answer.', metadata: { mode: 'thinking' }, createdAt: NOW },
    ],
    ...over.chat,
  },
  ...(({ chat: _c, ...rest }) => rest)(over),
});

/**
 * What loadSharedGeneratedImageParts' SQL returns for a message whose `parts`
 * is PARTS: only `type:'image' && source:'generated'` elements, `data` removed
 * (`- 'data'`), element order kept. Messages without a generated image (m1:
 * null parts, m3: text-only) produce NO row (jsonb_path_exists pre-filter).
 */
const sqlProjection = (parts: any[]) =>
  parts
    .filter((e) => e && typeof e === 'object' && e.type === 'image' && e.source === 'generated')
    .map(({ data: _d, ...rest }) => rest);

/** The $queryRaw tagged-template call: (strings, ...values). */
const queryRawCall = () => {
  const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
  return { sql: (strings as string[]).join('?'), values };
};

const mkReq = (over: any = {}): any => ({ params: { token: TOKEN, fileId: 'f-img' }, ...over });
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
  prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow());
  prismaMock.generatedFile.findUnique.mockResolvedValue(IMAGE_ROW);
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'm2', gen: sqlProjection(PARTS) }]);
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('sharedImagesFromParts (payload projection)', () => {
  it('keeps ONLY generated image parts with a fileId, as a field whitelist with the token-scoped url', () => {
    expect(sharedImagesFromParts(PARTS, TOKEN)).toEqual([
      {
        fileId: 'f-img',
        url: `/api/crossmodel/shared/chat/${TOKEN}/image/f-img`,
        name: 'Generated · 1024×1024 · "a red fox"',
        prompt: 'a red fox in the snow',
        mediaType: 'image/png',
      },
    ]);
  });

  it('never carries base64, the authed url, or a timestamp', () => {
    const [img] = sharedImagesFromParts(PARTS, TOKEN) as any[];
    expect(img.data).toBeUndefined();
    expect(img.ts).toBeUndefined();
    expect(JSON.stringify(img)).not.toContain('/generated-files/');
  });

  it('returns [] for legacy/non-array parts and for messages without generated images', () => {
    expect(sharedImagesFromParts(null, TOKEN)).toEqual([]);
    expect(sharedImagesFromParts(undefined, TOKEN)).toEqual([]);
    expect(sharedImagesFromParts({ type: 'image', source: 'generated', fileId: 'x' }, TOKEN)).toEqual([]);
    expect(sharedImagesFromParts([{ type: 'text', text: 'hi' }, null, 'junk', 42], TOKEN)).toEqual([]);
  });

  it('URL-encodes the token and file id in the path', () => {
    expect(sharedChatImagePath('a b/c', 'f?1')).toBe('/api/crossmodel/shared/chat/a%20b%2Fc/image/f%3F1');
  });
});

describe('shareLinkAccess (the one gate both public routes apply)', () => {
  it('classifies missing / revoked / expired / coding / ok', () => {
    expect(shareLinkAccess(null)).toBe('not_found');
    expect(shareLinkAccess(undefined)).toBe('not_found');
    expect(shareLinkAccess({ isActive: false, expiresAt: null, chat: {} }, NOW)).toBe('revoked');
    expect(shareLinkAccess({ isActive: true, expiresAt: new Date(NOW.getTime() - 1), chat: {} }, NOW)).toBe('expired');
    expect(shareLinkAccess({ isActive: true, expiresAt: new Date(NOW.getTime() + 1), chat: {} }, NOW)).toBe('ok');
    expect(shareLinkAccess({ isActive: true, expiresAt: null, chat: { codingState: { id: CHAT } } }, NOW)).toBe('coding');
    expect(shareLinkAccess({ isActive: true, expiresAt: null, chat: { codingState: null } }, NOW)).toBe('ok');
  });
});

// ── GET /shared/chat/:token — payload ─────────────────────────────────────────

describe('getSharedChat — generated images on the public payload', () => {
  it('NEVER selects `parts` on the message read; projects generated images with ONE chat-scoped SQL query that filters + strips `data` in the database', async () => {
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(200);
    const call = prismaMock.chatShareLink.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ shareToken: TOKEN });
    const select = call.include.chat.include.chatMessages.select;
    expect(select.parts).toBeUndefined(); // screenshots (inline base64) live there — never pulled for a public hit
    expect(select.id).toBe(true); // the join key back from the projection
    expect(select).toEqual({ id: true, role: true, content: true, metadata: true, createdAt: true });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = queryRawCall();
    expect(values).toEqual([CHAT]); // the ONLY parameter: the chat id — never the token, never user input
    expect(sql).toMatch(/FROM crossmodel_messages m/);
    expect(sql).toMatch(/WHERE m\."chatId" = \?/);
    // Picture-less messages transfer nothing: the row pre-filter names both the
    // type and the source in the jsonpath.
    expect(sql).toMatch(/jsonb_path_exists\(m\.parts, '\$\[\*\] \? \(@\.type == "image" && @\.source == "generated"\)'\)/);
    expect(sql).toMatch(/jsonb_typeof\(m\.parts\) = 'array'/);
    // Element filter + base64 strip happen in SQL, in transcript order.
    expect(sql).toMatch(/t\.e->>'type' = 'image' AND t\.e->>'source' = 'generated'/);
    expect(sql).toMatch(/jsonb_agg\(t\.e - 'data' ORDER BY t\.ord\)/);
    expect(sql).toMatch(/jsonb_array_elements\(m\.parts\) WITH ORDINALITY/);
  });

  it('maps the projection back onto its message by id and exposes only generated images', async () => {
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(200);

    const { messages } = res.body;
    expect(messages).toHaveLength(3);
    expect(messages[1].images).toEqual([
      {
        fileId: 'f-img',
        url: `/api/crossmodel/shared/chat/${TOKEN}/image/f-img`,
        name: 'Generated · 1024×1024 · "a red fox"',
        prompt: 'a red fox in the snow',
        mediaType: 'image/png',
      },
    ]);
    // The message shape otherwise is the pre-existing one.
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'Here is your fox.',
      timestamp: NOW.toISOString(),
      metadata: { mode: 'thinking' },
      images: messages[1].images,
    });
  });

  it('never leaks the raw parts array, tool/reasoning parts, screenshots or base64 anywhere in the payload', async () => {
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    const json = JSON.stringify(res.body);
    for (const m of res.body.messages) expect(m.parts).toBeUndefined();
    for (const sentinel of [
      'SENTINEL-REASONING', 'SENTINEL-TOOLCALL', 'SENTINEL-TOOLRESULT', 'SENTINEL-SUBAGENT',
      'SENTINEL-SCREENSHOT-BYTES', 'SENTINEL-PAGEURL', 'SENTINEL-COMPUTER-BYTES', 'SENTINEL-APP',
      'SENTINEL-GENERATED-BYTES', 'SENTINEL-ATTACHMENT-BYTES', 'SENTINEL-NOFILEID',
      '"tool_call"', '"tool_result"', '"reasoning"', '"data":', '/generated-files/',
    ]) {
      expect(json).not.toContain(sentinel);
    }
  });

  it('omits `images` on messages without generated images (serialization unchanged for picture-less chats)', async () => {
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect('images' in res.body.messages[0]).toBe(false); // user turn, parts null → no projection row
    expect('images' in res.body.messages[2]).toBe(false); // text-only parts → no projection row
    expect(res.body.messages[0]).toEqual({ role: 'user', content: 'draw a fox', timestamp: NOW.toISOString() });
    // The message `id` is a join key only — it never reaches the public payload.
    for (const m of res.body.messages) expect(m.id).toBeUndefined();
  });

  it('serializes a chat with no generated images at all exactly as before (empty projection)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.messages).toEqual([
      { role: 'user', content: 'draw a fox', timestamp: NOW.toISOString() },
      { role: 'assistant', content: 'Here is your fox.', timestamp: NOW.toISOString(), metadata: { mode: 'thinking' } },
      { role: 'assistant', content: 'Plain answer.', timestamp: NOW.toISOString(), metadata: { mode: 'thinking' } },
    ]);
  });

  it('skips the projection query for a message-less chat', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ chat: { chatMessages: [] } }));
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('still applies the field whitelist over the projection (defense-in-depth: stray data / ts / authed url / non-generated elements never leave)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        id: 'm2',
        gen: [
          { ...GENERATED_PART, data: 'SENTINEL-GENERATED-BYTES' }, // a row the SQL strip somehow missed
          { type: 'image', mediaType: 'image/png', data: 'SENTINEL-SCREENSHOT-BYTES', source: 'browser', pageUrl: 'https://SENTINEL-PAGEURL' },
          { type: 'tool_result', name: 'web_search', text: 'SENTINEL-TOOLRESULT' },
          { type: 'image', source: 'generated', url: '/api/crossmodel/generated-files/SENTINEL-NOFILEID/inline' },
        ],
      },
      { id: 'm-orphan', gen: [GENERATED_PART] }, // a projection row for an id not on the page → ignored
    ]);
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.messages[1].images).toEqual([
      {
        fileId: 'f-img',
        url: `/api/crossmodel/shared/chat/${TOKEN}/image/f-img`,
        name: 'Generated · 1024×1024 · "a red fox"',
        prompt: 'a red fox in the snow',
        mediaType: 'image/png',
      },
    ]);
    const json = JSON.stringify(res.body);
    for (const sentinel of ['SENTINEL-', '"data":', '"ts":', '/generated-files/', '"tool_result"', 'm-orphan']) {
      expect(json).not.toContain(sentinel);
    }
  });

  it('keeps its own status codes: 404 missing, 410 revoked, 410 expired, 404 coding chat — and runs NO projection query on any refusal', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(null);
    let res = mkRes();
    await getSharedChat(mkReq(), res);
    expect([res.statusCode, res.body]).toEqual([404, { error: 'Share link not found' }]);

    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ isActive: false }));
    res = mkRes();
    await getSharedChat(mkReq(), res);
    expect([res.statusCode, res.body]).toEqual([410, { error: 'This share link has been revoked' }]);

    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ expiresAt: new Date(Date.now() - 60_000) }));
    res = mkRes();
    await getSharedChat(mkReq(), res);
    expect([res.statusCode, res.body]).toEqual([410, { error: 'This share link has expired' }]);

    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ chat: { codingState: { id: CHAT } } }));
    res = mkRes();
    await getSharedChat(mkReq(), res);
    expect([res.statusCode, res.body]).toEqual([404, { error: 'Share link not found' }]);

    // A revoked/expired/missing link must not cost the second (jsonb) query.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('500s (never throws) when the projection query fails', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await getSharedChat(mkReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load shared chat' });
  });
});

// ── GET /shared/chat/:token/image/:fileId — bytes ─────────────────────────────

describe('getSharedChatImage — token-scoped public bytes', () => {
  it('serves the chat-bound image inline: essence Content-Type, nosniff, PUBLIC hour cache, the decoded bytes', async () => {
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(prismaMock.chatShareLink.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { shareToken: TOKEN } }));
    expect(prismaMock.generatedFile.findUnique).toHaveBeenCalledWith({ where: { id: 'f-img' } });
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Content-Length']).toBe(PNG.length);
    expect(res.headers['Content-Disposition']).toMatch(/^inline; filename="image-20260924-140322-a-red-fox\.png"; filename\*=UTF-8''/);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Cache-Control']).toBe('public, max-age=3600');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(PNG)).toBe(true);
  });

  it('normalizes a parameterized stored mime to its essence', async () => {
    prismaMock.generatedFile.findUnique.mockResolvedValue({ ...IMAGE_ROW, mimeType: 'image/webp; charset=binary' });
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/webp');
  });

  const expect404 = (res: any) => {
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(res.send).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toBeUndefined();
  };

  it('404s a missing link without touching generated_files', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(null);
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);
    expect(prismaMock.generatedFile.findUnique).not.toHaveBeenCalled();
  });

  it('404s an inactive (revoked) link — never the page endpoint\'s 410', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ isActive: false }));
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);
    expect(prismaMock.generatedFile.findUnique).not.toHaveBeenCalled();
  });

  it('404s an expired link (a still-future expiry passes)', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ expiresAt: new Date(Date.now() - 1_000) }));
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);

    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ expiresAt: new Date(Date.now() + 60_000) }));
    const ok = mkRes();
    await getSharedChatImage(mkReq(), ok);
    expect(ok.statusCode).toBe(200);
  });

  it('404s a coding chat (defense-in-depth, same as the page)', async () => {
    prismaMock.chatShareLink.findUnique.mockResolvedValue(linkRow({ chat: { codingState: { id: CHAT } } }));
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);
    expect(prismaMock.generatedFile.findUnique).not.toHaveBeenCalled();
  });

  it("404s a file owned by someone other than the chat's owner", async () => {
    prismaMock.generatedFile.findUnique.mockResolvedValue({ ...IMAGE_ROW, userId: 'u-other' });
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);
  });

  it("404s the owner's file from a DIFFERENT chat (a token never unlocks the owner's other pictures) or with no chat attribution", async () => {
    prismaMock.generatedFile.findUnique.mockResolvedValue({ ...IMAGE_ROW, chatId: 'chat-2' });
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect404(res);

    prismaMock.generatedFile.findUnique.mockResolvedValue({ ...IMAGE_ROW, chatId: null });
    const res2 = mkRes();
    await getSharedChatImage(mkReq(), res2);
    expect404(res2);
  });

  it('404s (never 415) a non-image row — pdf, xlsx, markdown, html — and scripting-capable SVG', async () => {
    for (const mimeType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/markdown', 'text/html', 'image/svg+xml']) {
      prismaMock.generatedFile.findUnique.mockResolvedValue({ ...IMAGE_ROW, id: 'f-doc', mimeType, filename: 'report.bin' });
      const res = mkRes();
      await getSharedChatImage(mkReq({ params: { token: TOKEN, fileId: 'f-doc' } }), res);
      expect({ mimeType, status: res.statusCode, body: res.body }).toEqual({ mimeType, status: 404, body: { error: 'Not found' } });
      expect(res.status).not.toHaveBeenCalledWith(415);
    }
  });

  it('404s a missing file', async () => {
    prismaMock.generatedFile.findUnique.mockResolvedValue(null);
    const res = mkRes();
    await getSharedChatImage(mkReq({ params: { token: TOKEN, fileId: 'nope' } }), res);
    expect404(res);
  });

  it('500s (never throws) on a DB failure', async () => {
    prismaMock.chatShareLink.findUnique.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await getSharedChatImage(mkReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load image' });
  });
});
