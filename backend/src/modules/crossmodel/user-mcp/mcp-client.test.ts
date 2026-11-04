/**
 * User-added MCP servers (ticket e294f9a4) — the generic MCP client against a
 * REAL local HTTP server (node:http on 127.0.0.1): both transports, session
 * handling, server→client requests, honest errors. The URL guard's private-
 * host / plain-http refusals are lifted for the loopback fixture through the
 * two documented switches (USER_MCP_ALLOW_PRIVATE_HOSTS / USER_MCP_ALLOW_HTTP);
 * a separate case pins the guard ON.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { connectMcp, probeMcpServer, McpClientError, SseParser } from './mcp-client';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface Fixture { url: string; close: () => Promise<void>; requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: any }> }

async function startServer(handler: Handler): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: any = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
      requests.push({ method: req.method || '', path: req.url || '', headers: req.headers, body: parsed });
      handler(req, res, body);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

const TOOLS_PAGE_1 = [
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
];
const TOOLS_PAGE_2 = [
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
];

/** A Streamable HTTP MCP server. `mode` picks JSON or SSE answers; `session` assigns an Mcp-Session-Id. */
function streamableHandler(opts: { mode: 'json' | 'sse'; session?: string; expireOnce?: boolean; pingFirst?: boolean }): Handler {
  let expired = false;
  return (req, res, raw) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    const msg = JSON.parse(raw);
    if (opts.session && msg.method !== 'initialize' && req.headers['mcp-session-id'] !== opts.session) { res.writeHead(400).end('missing session'); return; }
    if (opts.expireOnce && msg.method === 'tools/call' && !expired) { expired = true; res.writeHead(404).end(); return; }
    if (msg.method === 'notifications/initialized' || msg.id === undefined) { res.writeHead(202).end(); return; }
    let result: any;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '9.9' } };
    else if (msg.method === 'tools/list') result = msg.params?.cursor ? { tools: TOOLS_PAGE_2 } : { tools: TOOLS_PAGE_1, nextCursor: 'p2' };
    else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }] };
    else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })); return; }
    const headers: Record<string, string> = {};
    if (opts.session && msg.method === 'initialize') headers['mcp-session-id'] = opts.session;
    const answer = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    if (opts.mode === 'json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(answer); return; }
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    if (opts.pingFirst && msg.method === 'tools/call') res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' })}\n\n`);
    res.write(`: keepalive\n\nevent: message\ndata: ${answer}\n\n`);
    res.end();
  };
}

const ENV = { ...process.env };
beforeEach(() => { process.env.USER_MCP_ALLOW_PRIVATE_HOSTS = '1'; process.env.USER_MCP_ALLOW_HTTP = '1'; });
afterEach(() => { process.env = { ...ENV }; });

describe('Streamable HTTP', () => {
  it('JSON answers: initialize (session id kept) → initialized notification → paginated tools/list → tools/call; the auth header + session + protocol headers ride every later request', async () => {
    const fx = await startServer(streamableHandler({ mode: 'json', session: 'sess-123' }));
    try {
      const conn = await connectMcp({ url: `${fx.url}/mcp`, transport: 'auto', headers: { Authorization: 'Bearer tok-SECRET' } }, { timeoutMs: 5_000 });
      expect(conn.info).toMatchObject({ transport: 'streamable_http', protocolVersion: '2025-06-18', serverName: 'fixture', serverVersion: '9.9', hasTools: true });
      const { tools, truncated } = await conn.listTools();
      expect(tools.map((t) => t.name)).toEqual(['list_issues', 'create_issue']);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(truncated).toBe(false);
      const r = await conn.callTool('list_issues', { q: 'bug' });
      expect(r.content?.[0]).toEqual({ type: 'text', text: 'called list_issues with {"q":"bug"}' });
      await conn.close();
      const methods = fx.requests.map((q) => `${q.method} ${q.body?.method ?? ''}`.trim());
      expect(methods).toEqual(['POST initialize', 'POST notifications/initialized', 'POST tools/list', 'POST tools/list', 'POST tools/call', 'DELETE']);
      for (const q of fx.requests) expect(q.headers.authorization).toBe('Bearer tok-SECRET');
      for (const q of fx.requests.slice(1)) {
        expect(q.headers['mcp-session-id']).toBe('sess-123');
        expect(q.headers['mcp-protocol-version']).toBe('2025-06-18');
      }
      expect(fx.requests[0].body.params).toMatchObject({ protocolVersion: '2025-06-18', clientInfo: { name: 'digby' } });
    } finally { await fx.close(); }
  });

  it('SSE answers: the response is read off the event stream, and a server ping that arrives first is answered with {}', async () => {
    const fx = await startServer(streamableHandler({ mode: 'sse', pingFirst: true }));
    try {
      const conn = await connectMcp({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 5_000 });
      const r = await conn.callTool('create_issue', { title: 'x' });
      expect(r.content?.[0]?.text).toBe('called create_issue with {"title":"x"}');
      await new Promise((res) => setTimeout(res, 50));
      const pong = fx.requests.find((q) => q.body?.id === 'srv-1');
      expect(pong?.body).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: {} });
    } finally { await fx.close(); }
  });

  it('an EXPIRED session (404 on a session\'d request) re-initializes once and retries the call', async () => {
    const fx = await startServer(streamableHandler({ mode: 'json', session: 'sess-A', expireOnce: true }));
    try {
      const conn = await connectMcp({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 5_000 });
      const r = await conn.callTool('list_issues', {});
      expect(r.content?.[0]?.text).toMatch(/^called list_issues/);
      expect(fx.requests.filter((q) => q.body?.method === 'initialize')).toHaveLength(2);
    } finally { await fx.close(); }
  });

  it('a server without the tools method answers zero tools, not a failure', async () => {
    const fx = await startServer((req, res, raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const body = msg.method === 'initialize'
        ? { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'bare' } } }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    try {
      const p = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'auto' }, { timeoutMs: 5_000 });
      expect(p).toMatchObject({ ok: true, tools: [], info: { protocolVersion: '2025-03-26', hasTools: false } });
    } finally { await fx.close(); }
  });
});

describe('legacy HTTP+SSE (auto fallback)', () => {
  it('a POST answered 405 falls back to the legacy SSE GET: the endpoint event is followed, requests are POSTed there and answers come off the stream', async () => {
    let stream: http.ServerResponse | null = null;
    const fx = await startServer((req, res, raw) => {
      if (req.method === 'GET' && req.url === '/legacy') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n');
        stream = res;
        return;
      }
      if (req.method === 'POST' && req.url === '/legacy') { res.writeHead(405).end(); return; }
      if (req.method === 'POST' && req.url === '/messages?sessionId=abc') {
        res.writeHead(202).end('Accepted');
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return;
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'legacy' } }
          : msg.method === 'tools/list' ? { tools: TOOLS_PAGE_1 } : { content: [{ type: 'text', text: 'legacy ok' }] };
        stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
    try {
      // A non-/sse path ⇒ Streamable HTTP is tried FIRST; its 405 falls back to SSE.
      const conn = await connectMcp({ url: `${fx.url}/legacy`, transport: 'auto' }, { timeoutMs: 5_000 });
      expect(conn.info).toMatchObject({ transport: 'sse', protocolVersion: '2024-11-05', serverName: 'legacy' });
      expect((await conn.listTools()).tools.map((t) => t.name)).toEqual(['list_issues']);
      expect((await conn.callTool('list_issues', {})).content?.[0]?.text).toBe('legacy ok');
      await conn.close();
      expect(fx.requests[0]).toMatchObject({ method: 'POST', path: '/legacy' });
      expect(fx.requests[1]).toMatchObject({ method: 'GET', path: '/legacy' });
      const p = await probeMcpServer({ url: `${fx.url}/legacy`, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(p.ok).toBe(false); // forced Streamable HTTP never falls back
      expect(p.errorClass).toBe('http');
    } finally { await fx.close(); }
  });

  it('an endpoint event naming ANOTHER host is refused (no cross-origin message endpoint)', async () => {
    const fx = await startServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: endpoint\ndata: https://evil.example.com/messages\n\n'); return; }
      res.writeHead(404).end();
    });
    try {
      const p = await probeMcpServer({ url: `${fx.url}/sse`, transport: 'sse' }, { timeoutMs: 3_000 });
      expect(p).toMatchObject({ ok: false, errorClass: 'protocol' });
      expect(p.error).toMatch(/different host/);
    } finally { await fx.close(); }
  });
});

describe('honest errors', () => {
  it('401 with a resource_metadata challenge ⇒ kind auth + oauth, never echoing the token', async () => {
    const fx = await startServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"', 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
    });
    try {
      const p = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'auto', headers: { Authorization: 'Bearer super-secret-value' } }, { timeoutMs: 3_000 });
      expect(p).toMatchObject({ ok: false, errorClass: 'auth', oauth: true });
      expect(p.error).toMatch(/HTTP 401/);
      expect(p.error).not.toContain('super-secret-value');
      expect(fx.requests).toHaveLength(1); // an auth failure never falls back to SSE
    } finally { await fx.close(); }
  });

  it('403 ⇒ auth (permission), 302 ⇒ http "redirected … use the final URL" (never followed), 500 ⇒ http with the body excerpt', async () => {
    let status = 403;
    const fx = await startServer((_req, res) => {
      if (status === 302) { res.writeHead(302, { location: 'https://other.example.com/mcp' }).end(); return; }
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 500 ? 'boom: upstream down' : 'no');
    });
    try {
      const forbidden = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(forbidden).toMatchObject({ ok: false, errorClass: 'auth' });
      expect(forbidden.error).toMatch(/403/);
      status = 302;
      const redirect = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(redirect).toMatchObject({ ok: false, errorClass: 'http' });
      expect(redirect.error).toMatch(/redirected to https:\/\/other\.example\.com\/mcp/);
      status = 500;
      const err = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(err).toMatchObject({ ok: false, errorClass: 'http' });
      expect(err.error).toMatch(/HTTP 500 — boom: upstream down/);
    } finally { await fx.close(); }
  });

  it('a server that never answers ⇒ timeout inside the deadline', async () => {
    const fx = await startServer(() => { /* hang */ });
    try {
      const t0 = Date.now();
      const p = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'streamable_http' }, { timeoutMs: 600 });
      expect(p).toMatchObject({ ok: false, errorClass: 'timeout' });
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally { await fx.close(); }
  });

  it('an HTML page (not an MCP endpoint) ⇒ protocol error naming the content type; auto then tries SSE and reports that', async () => {
    const fx = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hi</html>'); });
    try {
      const p = await probeMcpServer({ url: `${fx.url}/`, transport: 'auto' }, { timeoutMs: 3_000 });
      expect(p).toMatchObject({ ok: false, errorClass: 'protocol' });
      expect(p.error).toMatch(/text\/html/);
      expect(fx.requests.map((q) => q.method)).toEqual(['POST', 'GET']);
    } finally { await fx.close(); }
  });

  it('a JSON-RPC error on tools/call surfaces as kind rpc with the server\'s message', async () => {
    const fx = await startServer((_req, res, raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const body = msg.method === 'initialize'
        ? { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: nope' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    try {
      const conn = await connectMcp({ url: `${fx.url}/mcp`, transport: 'auto' }, { timeoutMs: 3_000 });
      await expect(conn.callTool('nope', {})).rejects.toMatchObject({ kind: 'rpc', extra: { rpcCode: -32602 } });
      await expect(conn.callTool('nope', {})).rejects.toThrow(/Unknown tool: nope/);
    } finally { await fx.close(); }
  });

  it('with the guard ON, a loopback / plain-http URL is refused before any request (blocked_url) and nothing is contacted', async () => {
    const fx = await startServer((_req, res) => { res.writeHead(500).end(); });
    try {
      delete process.env.USER_MCP_ALLOW_PRIVATE_HOSTS;
      const p = await probeMcpServer({ url: `${fx.url.replace('http:', 'https:')}/mcp`, transport: 'auto' }, { timeoutMs: 2_000 });
      expect(p).toMatchObject({ ok: false, errorClass: 'blocked_url' });
      delete process.env.USER_MCP_ALLOW_HTTP;
      process.env.USER_MCP_ALLOW_PRIVATE_HOSTS = '1';
      const plain = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'auto' }, { timeoutMs: 2_000 });
      expect(plain).toMatchObject({ ok: false, errorClass: 'blocked_url' });
      expect(fx.requests).toHaveLength(0);
    } finally { await fx.close(); }
  });

  it('when both transports fail, the informative answer wins over a bare "wrong transport" (a 400 reason beats the SSE GET 405)', async () => {
    const fx = await startServer((req, res) => {
      if (req.method === 'POST') { res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad Request: missing required header X-Org'); return; }
      res.writeHead(405).end();
    });
    try {
      const p = await probeMcpServer({ url: `${fx.url}/mcp`, transport: 'auto' }, { timeoutMs: 3_000 });
      expect(p).toMatchObject({ ok: false, errorClass: 'http' });
      expect(p.error).toMatch(/HTTP 400 — Bad Request: missing required header X-Org/);
      expect(fx.requests.map((q) => q.method)).toEqual(['POST', 'GET']);
    } finally { await fx.close(); }
  });

  it('DNS rebinding: a public-looking host name whose answer is private is refused at CONNECT time (the request\'s own lookup), and allowed only under USER_MCP_ALLOW_PRIVATE_HOSTS', async () => {
    const dns = require('dns');
    const realLookup = dns.lookup;
    const spy = jest.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: any, cb: any) => {
      if (host === 'mcp.rebind.test') { cb(null, [{ address: '127.0.0.1', family: 4 }]); return; }
      return realLookup(host, opts, cb);
    }) as any);
    const fx = await startServer(streamableHandler({ mode: 'json' }));
    try {
      const port = new URL(fx.url).port;
      const url = `http://mcp.rebind.test:${port}/mcp`;
      delete process.env.USER_MCP_ALLOW_PRIVATE_HOSTS; // http still allowed for the fixture
      const refused = await probeMcpServer({ url, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(refused).toMatchObject({ ok: false, errorClass: 'blocked_url' });
      expect(refused.error).toMatch(/resolves to a private/);
      expect(fx.requests).toHaveLength(0);
      process.env.USER_MCP_ALLOW_PRIVATE_HOSTS = '1';
      const allowed = await probeMcpServer({ url, transport: 'streamable_http' }, { timeoutMs: 3_000 });
      expect(allowed.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith('mcp.rebind.test', expect.anything(), expect.any(Function));
    } finally { spy.mockRestore(); await fx.close(); }
  });

  it('McpClientError carries its kind', () => {
    const e = new McpClientError('timeout', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('timeout');
  });
});

describe('SseParser', () => {
  it('handles CRLF, multi-line data, comments, split chunks and default event names', () => {
    const p = new SseParser();
    const out = [
      ...p.push(': hello\r\nevent: endpoint\r\ndata: /messa'),
      ...p.push('ges\r\n\r\ndata: line1\ndata: line2\n\n'),
      ...p.push('id: 7\ndata: {"a":1}\n'),
      ...p.push('\n'),
    ];
    expect(out).toEqual([
      { event: 'endpoint', data: '/messages' },
      { event: 'message', data: 'line1\nline2' },
      { event: 'message', data: '{"a":1}', id: '7' },
    ]);
  });

  it('an event over the size cap throws too_large', () => {
    const p = new SseParser(10);
    expect(() => p.push('data: 0123456789ABCDEF\n')).toThrow(McpClientError);
  });
});
