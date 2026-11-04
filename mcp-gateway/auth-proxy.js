// auth-proxy.js
// Minimal API key auth layer for the BrightData MCP server
// Listens on PORT (default 8000), validates X-API-Key or Authorization: Bearer,
// then forwards to supergateway on UPSTREAM_PORT (default 8001)

'use strict';
const http = require('http');

const PORT = parseInt(process.env.AUTH_PROXY_PORT || '8000');
const UPSTREAM_PORT = parseInt(process.env.SUPERGATEWAY_PORT || '8001');
const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) {
  console.error('[auth-proxy] ERROR: MCP_API_KEY environment variable is not set');
  process.exit(1);
}

// ── Upstream (supergateway) watchdog ────────────────────────────────────────────
// The container stays alive as long as THIS process runs, but supergateway runs as
// a separate background process. If it dies/hangs, we used to keep serving traffic
// and 502 every tool call while /health still answered "ok" — so Docker never marked
// the container unhealthy and `restart: unless-stopped` never fired (it recovered
// only via a manual restart). Now: actively probe supergateway, make /health HONEST
// (503 when the upstream is down so the Docker healthcheck + the backend's gateway
// health-gate both see reality), and EXIT after a sustained outage so Docker's
// restart policy recreates a clean container (a real self-heal).
const PROBE_INTERVAL_MS = 15000;   // probe supergateway /health every 15s
const PROBE_TIMEOUT_MS  = 5000;
const EXIT_AFTER_FAILS  = 4;       // ~60s sustained down → exit for a clean restart
let upstreamHealthy = true;        // optimistic at boot (start_period covers warmup)
let probeFails = 0;

function probeUpstream() {
  const req = http.get({ hostname: '127.0.0.1', port: UPSTREAM_PORT, path: '/health', timeout: PROBE_TIMEOUT_MS }, (r) => {
    r.resume(); // drain
    if (r.statusCode === 200) {
      if (!upstreamHealthy) console.log('[auth-proxy] upstream RECOVERED');
      upstreamHealthy = true; probeFails = 0;
    } else {
      onProbeFail(`status ${r.statusCode}`);
    }
  });
  req.on('timeout', () => { req.destroy(new Error('probe timeout')); });
  req.on('error', (e) => onProbeFail(e.message));
}

function onProbeFail(why) {
  probeFails++;
  upstreamHealthy = false;
  console.warn(`[auth-proxy] upstream probe failed (${probeFails}/${EXIT_AFTER_FAILS}): ${why}`);
  if (probeFails >= EXIT_AFTER_FAILS) {
    console.error('[auth-proxy] supergateway down for too long — exiting so Docker restarts the container');
    process.exit(1);
  }
}

setInterval(probeUpstream, PROBE_INTERVAL_MS).unref();

// ── Cgroup memory watchdog (2026-07-14) ─────────────────────────────────────────
// The long-lived supergateway process LEAKS: prod hit 99% of the 2GiB cgroup with
// the memcg OOM-killer reaping the (small) @brightdata/mcp child 22×/30min — each
// respawn a 10-20s window of empty SSE bodies. Per-process heap caps don't bound
// native/external buffers, so watch the CGROUP: two consecutive reads above the
// threshold → exit(1) for a clean container restart (seconds of downtime, hours of
// leak headroom reclaimed). cgroup v2 first, v1 fallback; absent files = disabled.
const MEM_THRESHOLD = 0.92;
let memStrikes = 0;
function readCgroupMem() {
  const fs = require('fs');
  try {
    const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'), 10);
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (maxRaw === 'max') return null;
    return cur / parseInt(maxRaw, 10);
  } catch {
    try {
      const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'), 10);
      const max = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'), 10);
      if (!Number.isFinite(max) || max <= 0 || max > 2 ** 60) return null;
      return cur / max;
    } catch { return null; }
  }
}
setInterval(() => {
  const frac = readCgroupMem();
  if (frac == null) return;
  if (frac >= MEM_THRESHOLD) {
    memStrikes++;
    console.warn(`[auth-proxy] cgroup memory at ${(frac * 100).toFixed(0)}% (strike ${memStrikes}/2)`);
    if (memStrikes >= 2) {
      console.error('[auth-proxy] memory leak pressure — exiting for a clean container restart');
      process.exit(1);
    }
  } else {
    memStrikes = 0;
  }
}, 30000).unref();

const server = http.createServer((req, res) => {
  // Health check (no auth). HONEST: reflects supergateway liveness so a degraded
  // gateway is actually reported unhealthy instead of masquerading as "ok".
  if (req.url === '/health') {
    if (upstreamHealthy) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('upstream unavailable');
    }
    return;
  }

  // Check API key from X-API-Key header or Authorization: Bearer
  const providedKey = req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!providedKey || providedKey !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      message: 'Valid API key required. Use X-API-Key header or Authorization: Bearer <key>'
    }));
    return;
  }

  // Forward to supergateway
  const options = {
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` }
  };

  const proxy = http.request(options, (proxyRes) => {
    // A real response means the upstream is alive — clear any watchdog suspicion.
    upstreamHealthy = true; probeFails = 0;
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on('error', () => {
    // Couldn't reach supergateway — this IS the 502-on-every-tool-call symptom.
    // Mark unhealthy now so /health flips immediately; the probe loop then decides
    // whether the outage is sustained enough to exit for a restart.
    upstreamHealthy = false;
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
