/**
 * digby-mcp — the Digby platform, exposed as MCP tools (Phase P6).
 *
 * Transports:
 *   • HTTP (default, house pattern): StreamableHTTP on POST /mcp, one stateless
 *     server per request. The MCP client supplies the END USER'S credential in
 *     the standard `Authorization: Bearer <token>` header — their Digby JWT or
 *     an agent token (dgt_…) minted in Account → Developer.
 *   • stdio (--stdio or DIGBY_MCP_TRANSPORT=stdio): for local MCP clients
 *     (Claude Desktop-style). The token comes from DIGBY_USER_TOKEN.
 *
 * AUTH MODEL: per-user pass-through, NEVER shared-key. The token is forwarded
 * verbatim to ${DIGBY_API_URL:-http://localhost:4000}/api/crossmodel/platform/*.
 * This server holds no credential of its own and contains no permission logic:
 * agent-token scope enforcement + owner/member scoping stay server-side in the
 * backend (middleware/agent-auth.ts). The mcp-gateway shared-MCP_API_KEY
 * pattern is deliberately NOT copied — a shared key would make every caller
 * act with one over-privileged identity (confused deputy).
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerDigbyTools } from './tools/digby.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);

function buildServer(authorization: string): McpServer {
  const server = new McpServer({ name: 'digby', version: '1.0.0' });
  registerDigbyTools(server, authorization);
  return server;
}

const MISSING_TOKEN_MESSAGE =
  'A per-user Digby credential is required: pass Authorization: Bearer <token> ' +
  '(your Digby JWT, or an agent token dgt_… minted in Account → Developer). ' +
  'For stdio mode set DIGBY_USER_TOKEN.';

async function runStdio(): Promise<void> {
  const raw = (process.env.DIGBY_USER_TOKEN || '').trim();
  if (!raw) {
    console.error(`[digby-mcp] ERROR: DIGBY_USER_TOKEN is not set. ${MISSING_TOKEN_MESSAGE}`);
    process.exit(1);
  }
  const authorization = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  const server = buildServer(authorization);
  await server.connect(new StdioServerTransport());
  // stdio: stdout is the protocol channel — logs go to stderr only.
  console.error(`[digby-mcp] stdio ready → ${process.env.DIGBY_API_URL || 'http://localhost:4000'} (per-user token pass-through)`);
}

function runHttp(): void {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_, res) => res.send('ok'));

  app.post('/mcp', async (req, res) => {
    const authorization = req.headers.authorization as string | undefined;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized', message: MISSING_TOKEN_MESSAGE });
      return;
    }

    try {
      const server = buildServer(authorization);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[digby-mcp] Request error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`[digby-mcp] listening on :${PORT} → ${process.env.DIGBY_API_URL || 'http://localhost:4000'} (per-user token pass-through)`);
  });
}

if (process.argv.includes('--stdio') || process.env.DIGBY_MCP_TRANSPORT === 'stdio') {
  runStdio().catch((err) => {
    console.error('[digby-mcp] fatal:', err.message);
    process.exit(1);
  });
} else {
  runHttp();
}
