#!/usr/bin/env node
/**
 * MCP smoke for the five OSV-2 packages that ship a stdio-less HTTP container.
 *
 * Starts the BUILT dist/server.js of one package on a free port, then speaks
 * real MCP over HTTP: `initialize` (must answer a protocolVersion + serverInfo)
 * followed by `tools/list` (must answer a non-empty tool array). This is the
 * gate's "MCP smoke (`initialize` + `tools/list`) per container" — it proves a
 * dependency bump did not break the SDK's server/transport wiring.
 *
 * Usage: node mcp-smoke.mjs <package-dir>
 * Exit 0 = both legs OK. Exit 1 = failure (reason printed).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) { console.error('usage: node mcp-smoke.mjs <package-dir>'); process.exit(2); }

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`server did not answer /health within ${timeoutMs}ms`);
}

async function rpc(port, headers, body, label) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} — ${text.slice(0, 400)}`);
  // Streamable HTTP may answer as SSE; pull the first `data:` payload.
  if (text.trimStart().startsWith('event:') || text.includes('\ndata:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) throw new Error(`${label}: SSE frame without data — ${text.slice(0, 300)}`);
    return JSON.parse(line.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

const results = [];
let child;

try {
  const port = await freePort();
  const serverJs = path.resolve(pkgDir, 'dist', 'server.js');
  child = spawn(process.execPath, [serverJs], {
    cwd: path.resolve(pkgDir),
    env: {
      ...process.env,
      MCP_SERVER_PORT: String(port),
      PORT: String(port),
      // Shared-secret guards read these; the smoke only needs them non-empty so
      // the auth gate admits our request. No upstream API is contacted by
      // initialize / tools/list — neither leg invokes a tool.
      ASANA_MCP_API_KEY: 'smoke-key',
      X_MCP_API_KEY: 'smoke-key',
      GITHUB_MCP_API_KEY: 'smoke-key',
      SLACK_MCP_API_KEY: 'smoke-key',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });

  await waitForHealth(port, child);

  // Auth headers the per-package guards require. Each server checks the shared
  // x-api-key (google: none) plus its OWN per-user token header, and only
  // /health is unauthenticated — so the smoke sends all of them. Neither leg
  // invokes a tool, so no upstream API is contacted with these placeholder
  // tokens; they exist solely to pass the header-presence guard.
  const headers = {
    'x-api-key': 'smoke-key',
    'x-google-token': 'smoke-token',
    'x-asana-token': 'smoke-token',
    'x-github-token': 'smoke-token',
    'x-slack-token': 'smoke-token',
    'x-x-token': '',
  };

  const init = await rpc(port, headers, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'osv2-smoke', version: '1.0.0' },
    },
  }, 'initialize');
  if (init.error) throw new Error(`initialize returned an error — ${JSON.stringify(init.error)}`);
  const r = init.result || {};
  if (!r.protocolVersion) throw new Error('initialize: no protocolVersion in result');
  if (!r.serverInfo || !r.serverInfo.name) throw new Error('initialize: no serverInfo.name in result');
  results.push(`initialize ok (serverInfo.name=${r.serverInfo.name}, protocolVersion=${r.protocolVersion})`);

  // Some SDK builds want the client's initialized notification before a list.
  await rpc(port, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'initialized').catch(() => {});

  const list = await rpc(port, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'tools/list');
  if (list.error) throw new Error(`tools/list returned an error — ${JSON.stringify(list.error)}`);
  const tools = (list.result && list.result.tools) || [];
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools/list: empty tool array');
  const named = tools.filter((t) => t && typeof t.name === 'string' && t.name.length > 0);
  if (named.length !== tools.length) throw new Error('tools/list: a tool is missing its name');
  results.push(`tools/list ok (${tools.length} tools: ${named.slice(0, 3).map((t) => t.name).join(', ')}${tools.length > 3 ? ', …' : ''})`);

  console.log(`SMOKE PASS ${pkgDir}`);
  for (const line of results) console.log(`  ${line}`);
  child.kill('SIGTERM');
  process.exit(0);
} catch (err) {
  console.error(`SMOKE FAIL ${pkgDir}`);
  console.error(`  ${err && err.message ? err.message : err}`);
  if (child) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  process.exit(1);
}