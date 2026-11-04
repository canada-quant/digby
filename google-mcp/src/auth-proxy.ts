/**
 * Auth Proxy for Google MCP Server
 *
 * Listens on PORT (default 8000, external).
 * Validates X-API-Key header, then forwards request to the MCP server on
 * UPSTREAM_PORT (default 8001), INCLUDING the X-Google-Token header so the
 * MCP server can use it for per-user Google API calls.
 *
 * Pattern mirrors mcp-gateway/auth-proxy.js.
 */

import http from 'http';

const PORT          = parseInt(process.env.AUTH_PROXY_PORT   || '8000', 10);
const UPSTREAM_PORT = parseInt(process.env.MCP_SERVER_PORT   || '8001', 10);
const API_KEY       = process.env.GOOGLE_MCP_API_KEY;

if (!API_KEY) {
  console.error('[auth-proxy] ERROR: GOOGLE_MCP_API_KEY env var is not set');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Health check — no auth
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Validate API key from X-API-Key or Authorization: Bearer
  const providedKey =
    (req.headers['x-api-key'] as string | undefined) ||
    ((req.headers['authorization'] || '') as string).replace(/^Bearer\s+/i, '');

  if (!providedKey || providedKey !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error:   'Unauthorized',
      message: 'Valid API key required. Use X-API-Key header or Authorization: Bearer <key>',
    }));
    return;
  }

  // Forward to MCP server (includes all original headers, notably X-Google-Token)
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port:     UPSTREAM_PORT,
    path:     req.url,
    method:   req.method,
    headers:  { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxy, { end: true });
});

server.listen(PORT, () => {
  console.log(`[auth-proxy] Listening on :${PORT} → upstream :${UPSTREAM_PORT}`);
  console.log(`[auth-proxy] API key auth: enabled`);
});
