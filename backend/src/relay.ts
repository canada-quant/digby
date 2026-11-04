/**
 * Digby Edge (Phase 3) — RELAY process entry (`node dist/relay.js`).
 *
 * Same image as the web backend, different entry (worker.ts is the precedent).
 * Holds every edge's outbound WebSocket tunnel in THIS one process (the
 * deliberate module-memory exception — see relay/relay-core.ts) and proxies
 * authenticated cloud-admin HTTP requests down the matching tunnel. Port
 * RELAY_PORT (default 4100). Self-host compose routes the two relay path
 * families here directly (deploy/selfhost/Caddyfile); prod wiring is a later
 * owner-gated step.
 *
 * RelayCore is the unit-test seam (no sockets/ports); createRelayServer wires
 * it to real HTTP/WS transport (the integration-test seam); the main guard at
 * the bottom wires the process together.
 */

import http from 'http';
// Fail-fast env validation at boot (same zod schema as server.ts/worker.ts):
// the relay verifies cloud-admin JWTs and resolves dgi_ tunnel tokens, so a
// missing/short JWT_SECRET or DATABASE_URL must kill the boot loudly.
import './config/env';
import { WebSocketServer } from 'ws';
import prisma from './config/database';
import { connectRedis } from './config/redis';
import logger from './utils/logger';
import { RelayCore, TUNNEL_PATH, PROXY_PATH_RE, MESSAGES_PATH_RE } from './relay/relay-core';

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '4100', 10);

/**
 * HTTP + WS transport around a RelayCore: /health, the proxy path family, and
 * the authenticated tunnel upgrade. Exported for integration tests.
 */
export function createRelayServer(core: RelayCore): http.Server {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && pathname === '/health') return core.handleHealth(res);
    if (MESSAGES_PATH_RE.test(pathname)) {
      core.handleMessagesRequest(req, res).catch((err) => {
        logger.error('relay: unhandled messages error:', err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error' }));
      });
      return;
    }
    if (PROXY_PATH_RE.test(pathname)) {
      core.handleProxyRequest(req, res).catch((err) => {
        logger.error('relay: unhandled proxy error:', err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Cap frame payloads: proxied request bodies are ≤1 MB base64 (~1.4 MB on
  // the wire); 4 MB leaves headroom without inviting memory abuse.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://relay');
    if (u.pathname !== TUNNEL_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // ?name= is the edge's self-reported instance name — only used when the
    // bearer is a device-activation dgp_ code (the row is minted on contact).
    core.authenticateTunnelRequest(req.headers.authorization, u.searchParams.get('name') || undefined)
      .then((auth) => {
        if (!auth) {
          // Uniform 401 for every failure — unknown token, revoked, malformed,
          // expired/consumed device code.
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => core.handleTunnelUpgrade(auth, ws));
      })
      .catch((err) => {
        logger.error('relay: upgrade auth error:', err);
        socket.destroy();
      });
  });

  server.on('close', () => wss.close());
  return server;
}

const startRelay = async () => {
  try {
    await connectRedis();
    await prisma.$connect();
    logger.info('✅ Relay: Redis + database connected');

    const core = new RelayCore();
    const server = createRelayServer(core);

    server.listen(RELAY_PORT, '0.0.0.0', () => {
      logger.info(`🚀 Relay listening on port ${RELAY_PORT} (tunnel: ${TUNNEL_PATH})`);
    });

    const gracefulShutdown = (signal: string) => {
      logger.info(`${signal} received, relay shutting down`);
      server.close(async () => {
        await prisma.$disconnect();
        process.exit(0);
      });
      setTimeout(() => {
        logger.warn('Relay forced shutdown after 10s');
        process.exit(1);
      }, 10_000);
    };
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('❌ Failed to start relay:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  void startRelay();
}
