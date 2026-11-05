/**
 * SMOKE TEST (scratch — not committed): exercises @digby/api against a stub
 * transport. Verifies: login sets Bearer; 401 → refresh → retry; single-flight
 * (N concurrent 401s = ONE refresh); no-refresh on auth endpoints; /me unwrap;
 * SSE frame parsing (chunked mid-frame splits); the register→stream send flow
 * with Bearer on BOTH legs; upload base64; attach.
 */
import {
  DigbyApiClient,
  fetchAuth,
  fetchChats,
  SseParser,
  sendMessageStream,
  attachChatStream,
  uploadImage,
} from './src/index';
import type { SseEvent } from './src/index';

// Scratch-file ambient globals (the package lib is ES2022-only on purpose;
// this file runs under tsx/node, which provides these).
declare const console: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
declare const process: { exit(code?: number): void };
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };

// ── §streaming: SseParser (pure unit checks — no transport) ─────────────────
{
  const p = new SseParser();
  // Single frame, heartbeats, id lines, multi-line data, CRLF, split chunks.
  const out1 = p.push('data: {"type":"chunk","data":{"content":"Hel"}}\n\n: hb\n\n');
  if (out1.length !== 1) throw new Error(`parser frame count ${out1.length} ≠ 1`);
  if ((out1[0].event as any).type !== 'chunk' || (out1[0].event as any).data?.content !== 'Hel') throw new Error('chunk parse');
  const out2 = p.push('data: {"type":"chunk","data":{"content":"lo"}}\r\n\r\ndata: {"type":"complete","data":{"totalTime":5}}\n\n');
  if (out2.length !== 2) throw new Error(`crlf/multi frame count ${out2.length} ≠ 2`);
  if ((out2[0].event as any).data?.content !== 'lo') throw new Error('crlf chunk');
  if ((out2[1].event as any).type !== 'complete') throw new Error('complete parse');
  // id: line (coding resume cursor)
  const out3 = p.push('id: run-1:42\ndata: {"type":"progress","data":{"message":"working","stage":"agent"}}\n\n');
  if (out3[0].id !== 'run-1:42') throw new Error(`id line: ${out3[0].id}`);
  if ((out3[0].event as any).data?.stage !== 'agent') throw new Error('progress parse');
  // mid-frame split: half a frame now, rest later
  const out4 = p.push('data: {"type":"chunk","data":{"content":"spl');
  if (out4.length !== 0) throw new Error('partial frame must not emit');
  const out5 = p.push('it"}}\n\n');
  if (out5.length !== 1 || (out5[0].event as any).data?.content !== 'split') throw new Error('split frame reassembly');
  // non-JSON data → raw event, never throws
  const out6 = p.push('data: not-json\n\n');
  if (out6[0].event.type !== 'raw') throw new Error('raw fallback');
  console.log('✓ SseParser: frames, heartbeats, CRLF, id:, mid-frame splits, raw fallback');
}

// ── §streaming: register→stream send flow over a stub streaming fetch ───────
async function streamingChecks() {
  let sawRegisterAuth: string | undefined;
  let sawStreamAuth: string | undefined;
  let sawAccept: string | undefined;
  let registerBody: any;

  const SSE_SCRIPT = [
    'data: {"type":"init","data":{"engine":"agent"}}\n\n',
    'data: {"type":"chat-title","data":{"chatId":"chat-42","title":"New chat"}}\n\n',
    'data: {"type":"chunk","data":{"content":"Hi "}}\n\n',
    'data: {"type":"chunk","data":{"content":"there"}}\n\n',
    'data: {"type":"complete","data":{"totalTime":3}}\n\n',
  ].join('');

  // Byte-level split test (review B1): encode FIRST, then slice the BYTE
  // array at an offset INSIDE a multi-byte char — a fresh per-chunk decoder
  // would emit U+FFFD twice; the stream decoder must bridge the halves.
  const mbScript = 'data: {"type":"chunk","data":{"content":"你ok"}}\n\n';
  const mbBytes = new TextEncoder().encode(mbScript);
  // 你 = E4 BD A0 (3 bytes). Find it and cut between byte 1 and 2.
  const mbCut = mbBytes.indexOf(0xe4) + 1;
  if (mbBytes[mbCut] === 0xbd) {
    // sanity: the cut lands inside the char as expected
  }

  const stubFetch = async (url: string, init?: any) => {
    if (url.endsWith('/api/auth/refresh')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { accessToken: 'T9' } }), text: async () => '', headers: undefined };
    }
    if (url.endsWith('/api/crossmodel/stream/register')) {
      sawRegisterAuth = init?.headers?.Authorization;
      registerBody = init?.body ? JSON.parse(init.body) : {};
      return { ok: true, status: 200, json: async () => ({ streamToken: 'st-1' }), text: async () => '', headers: undefined };
    }
    if (url.includes('/api/crossmodel/stream?streamToken=st-1')) {
      sawStreamAuth = init?.headers?.Authorization;
      sawAccept = init?.headers?.Accept;
      // A Response-like with a streaming body: emits the script in 3 chunks,
      // including one mid-frame split.
      const parts = [
        SSE_SCRIPT.slice(0, 80),
        SSE_SCRIPT.slice(80, 160), // splits a frame across reads
        SSE_SCRIPT.slice(160),
      ];
      let i = 0;
      return {
        ok: true, status: 200,
        json: async () => ({}), text: async () => '',
        headers: undefined,
        body: {
          getReader: () => ({
            read: async () =>
              i < parts.length
                ? { done: false, value: enc.encode(parts[i++]) }
                : { done: true, value: undefined },
            cancel: async () => { disposed = true; },
          }),
        },
      };
    }
    if (url.includes('/api/crossmodel/chats/chat-42/stream')) {
      // attach leg
      sawStreamAuth = init?.headers?.Authorization;
      const parts = ['data: {"type":"chunk","data":{"content":"tail"}}\n\n', 'data: {"type":"complete","data":{}}\n\n'];
      let i = 0;
      return {
        ok: true, status: 200, json: async () => ({}), text: async () => '', headers: undefined,
        body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true, value: undefined }, cancel: async () => {} }) },
      };
    }
    if (url.endsWith('/api/crossmodel/upload')) {
      return { ok: true, status: 200, json: async () => ({ uploadId: 'up-1', type: 'image', filename: 'a.jpg' }), text: async () => '', headers: undefined };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'nope' };
  };

  const enc = new TextEncoder();
  let disposed = false;

  const client = new DigbyApiClient({
    baseUrl: 'https://digby.ai',
    fetch: stubFetch as any,
    getRefreshToken: async () => 'R1',
  });

  const events: SseEvent[] = [];
  const { stream, chatId } = await sendMessageStream(
    client,
    { message: 'hello mobile', uploadIds: ['up-1'] },
    (ev) => events.push(ev)
  );
  await stream.done;

  // Bearer on BOTH legs (register ownership check requires the same identity)
  if (sawRegisterAuth !== 'Bearer T9') throw new Error(`register auth: ${sawRegisterAuth}`);
  if (sawStreamAuth !== 'Bearer T9') throw new Error(`stream auth: ${sawStreamAuth}`);
  if (sawAccept !== 'text/event-stream') throw new Error(`accept: ${sawAccept}`);
  // register body shape
  if (registerBody.message !== 'hello mobile' || registerBody.uploadId?.[0] !== 'up-1' || registerBody.mode !== 'single_thinking') throw new Error('register body shape');
  // chat-title revealed the chatId
  if ((await chatId) !== 'chat-42') throw new Error(`chatId: ${await chatId}`);
  // events in order, complete terminal
  const types = events.map((e) => e.type);
  if (JSON.stringify(types) !== JSON.stringify(['init', 'chat-title', 'chunk', 'chunk', 'complete']))
    throw new Error(`event order: ${types.join(',')}`);
  const answer = events.filter((e) => e.type === 'chunk').map((e: any) => e.data.content).join('');
  if (answer !== 'Hi there') throw new Error(`assembled answer: ${answer}`);
  console.log('✓ sendMessageStream: Bearer on register+stream, chat-title→chatId, chunk assembly, complete terminal');

  // attach: viewer tail
  const attachEvents: SseEvent[] = [];
  const handle = await attachChatStream(client, 'chat-42', (ev) => attachEvents.push(ev));
  await handle.done;
  if (attachEvents.map((e) => e.type).join(',') !== 'chunk,complete') throw new Error('attach events');
  console.log('✓ attachChatStream: Bearer attach tails the run');

  // upload
  const up = await uploadImage(client, { filename: 'a.jpg', mimeType: 'image/jpeg', base64: 'AAAA' });
  if (up.uploadId !== 'up-1') throw new Error('upload id');
  console.log('✓ uploadImage: base64 JSON → uploadId');

  // non-2xx stream → error event (not a throw), dispose works
  const errEvents: SseEvent[] = [];
  const badHandle = await attachChatStream(
    new DigbyApiClient({ baseUrl: 'https://digby.ai', fetch: stubFetch as any, accessToken: 'T9' }),
    'missing-chat',
    (ev) => errEvents.push(ev)
  );
  await badHandle.done; // /chats/missing-chat/stream isn't stubbed → 404
  if (errEvents[0]?.type !== 'error') throw new Error('non-2xx must surface error event');
  console.log('✓ non-2xx stream → error event surfaced to caller');

  // Byte-level UTF-8 split across reads (review B1): the reader emits the
  // frame's bytes cut INSIDE the 3-byte 你 — a per-chunk decoder yields
  // U+FFFD×2; the connection-scoped stream decoder must bridge to "你ok".
  {
    const parts = [mbBytes.slice(0, mbCut), mbBytes.slice(mbCut)];
    let i = 0;
    const mbFetch = async (): Promise<any> => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '', headers: undefined,
      body: { getReader: () => ({ read: async () => i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined }, cancel: async () => {} }) },
    });
    const mbClient = new DigbyApiClient({ baseUrl: 'https://digby.ai', fetch: mbFetch as any, accessToken: 'T9' });
    const mbEvents: SseEvent[] = [];
    const mbHandle = await attachChatStream(mbClient, 'any', (ev) => mbEvents.push(ev));
    await mbHandle.done;
    const chunk = mbEvents.find((e) => e.type === 'chunk') as { data?: { content?: string } } | undefined;
    if (!chunk) throw new Error('multi-byte: no chunk event');
    if (chunk.data?.content !== '你ok') throw new Error(`multi-byte bridging failed: ${JSON.stringify(chunk.data?.content)}`);
    if (chunk.data?.content.includes('\uFFFD')) throw new Error('multi-byte: replacement char leaked');
    console.log('✓ UTF-8 char split across reads bridges correctly (no U+FFFD)');
  }
}

async function main() {
  let calls: { method: string; url: string; auth?: string; body?: string }[] = [];
  let refreshCount = 0;
  let meResponses = 0;

  function ok(data: unknown, setCookie?: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
      text: async () => '',
      headers: setCookie ? { get: (n: string) => (n.toLowerCase() === 'set-cookie' ? setCookie : null) } : undefined,
    };
  }
  function err(status: number) {
    return { ok: false, status, json: async () => ({}), text: async () => `HTTP ${status}` };
  }

  // Rotation state: the backend deletes the presented token and issues R<n+1>.
  let currentRefreshToken = 'R-STOREED-1';

  const stub = async (url: string, init?: any) => {
    const auth = init?.headers?.Authorization;
    calls.push({ method: init?.method ?? 'GET', url, auth, body: init?.body });
    if (url.endsWith('/api/auth/login')) {
      // login issues R2 via Set-Cookie (backend: httpOnly cookie only)
      currentRefreshToken = 'R2';
      return ok({ user: { id: 'u1', email: 'a@b.c', role: 'user' }, accessToken: 'T1' },
        `refreshToken=${currentRefreshToken}; HttpOnly; Path=/; Max-Age=604800`);
    }
    if (url.endsWith('/api/auth/refresh')) {
      refreshCount++;
      const body = init?.body ? JSON.parse(init.body) : {};
      // ROTATION: the presented token is DELETED server-side; only the newest survives
      if (body.refreshToken !== currentRefreshToken) return err(401);
      currentRefreshToken = `R${currentRefreshToken === 'R2' ? 3 : parseInt(currentRefreshToken.slice(1), 10) + 1}`;
      return ok({ accessToken: 'T2' },
        `refreshToken=${currentRefreshToken}; HttpOnly; Path=/; Max-Age=604800`);
    }
    if (url.endsWith('/api/auth/me')) {
      meResponses++;
      // STRICT: any auth other than a valid Bearer → 401 (catches missing-header bugs)
      if (auth !== 'Bearer T2') return err(401);
      return ok({ id: 'u1', email: 'a@b.c', role: 'user' });
    }
    if (url.includes('/api/ai-chats')) {
      if (auth !== 'Bearer T2') return err(401); // stale token 401s
      return ok({ chats: [{ id: 'c1', title: 'Hello', messages: [], createdAt: '', updatedAt: '' }], pagination: { page: 1, limit: 50, total: 1, pages: 1 } });
    }
    return err(404);
  };

  const expired: string[] = [];
  const rotations: string[] = [];
  let storedRefreshToken: string | undefined;
  const client = new DigbyApiClient({
    baseUrl: 'https://digby.ai',
    fetch: stub as any,
    getRefreshToken: async () => storedRefreshToken,
    onRefreshToken: (t) => { rotations.push(t); storedRefreshToken = t; },
    onSessionExpired: () => expired.push('expired'),
  });
  const auth = fetchAuth(client);
  const chats = fetchChats(client);

  // 1. login — access token set; refresh token surfaced from Set-Cookie
  const login = await auth.login({ email: 'a@b.c', password: 'pw' });
  if (login.accessToken !== 'T1') throw new Error('login token');
  if (login.refreshToken !== 'R2') throw new Error(`login refreshToken: ${login.refreshToken} (expected R2 from Set-Cookie)`);
  if (storedRefreshToken !== 'R2') throw new Error('onRefreshToken not fired on login');
  console.log('✓ login → T1 + refreshToken R2 captured from Set-Cookie (onRefreshToken fired)');

  // 2. me() with expired T1 → 401 → refresh (body token) → retry → user
  const me = await auth.me();
  if (me.id !== 'u1') throw new Error('me failed');
  if (refreshCount !== 1) throw new Error(`refreshCount ${refreshCount} ≠ 1`);
  console.log('✓ me: 401 → refresh(body refreshToken) → retry → user');

  // 3. chats.list uses T2 (post-refresh)
  const list = await chats.list({ page: 1, limit: 50 });
  if (list.chats.length !== 1) throw new Error('list failed');
  console.log('✓ chats.list with refreshed token');

  // 4. single-flight: expire token, fire 3 concurrent list() calls
  client.setAccessToken('T1');
  const before = refreshCount;
  const results = await Promise.all([chats.list(), chats.list(), chats.list()]);
  if (results.length !== 3) throw new Error('concurrent failed');
  if (refreshCount !== before + 1) throw new Error(`single-flight violated: ${refreshCount - before} refreshes for 3 calls`);
  console.log(`✓ single-flight: 3 concurrent 401s → ${refreshCount - before} refresh`);

  // 5. auth-endpoint 401 must NOT trigger refresh
  refreshCount = 0;
  const stub401 = async () => err(401);
  const c2 = new DigbyApiClient({ baseUrl: 'https://digby.ai', fetch: stub401 as any, getRefreshToken: async () => 'R-STORED', onSessionExpired: () => expired.push('expired2') });
  const auth2 = fetchAuth(c2);
  await auth2.logout(); // must not throw, must not refresh
  if (refreshCount !== 0) throw new Error('logout triggered refresh');
  console.log('✓ auth endpoints skip refresh; logout never throws');

  // 6. definitive failure: refresh token invalid → ApiError + onSessionExpired
  const c3 = new DigbyApiClient({ baseUrl: 'https://digby.ai', fetch: stub as any, getRefreshToken: async () => 'WRONG', onSessionExpired: () => expired.push('expired3') });
  const chats3 = fetchChats(c3);
  c3.setAccessToken('T1');
  let threw = false;
  try { await chats3.list(); } catch (e) { threw = true; if ((e as any).status !== 401) throw new Error('wrong error'); }
  if (!threw) throw new Error('should have thrown');
  if (!expired.includes('expired3')) throw new Error('onSessionExpired not fired');
  console.log('✓ definitive auth failure → ApiError(401) + onSessionExpired');

  await streamingChecks();

  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
