#!/usr/bin/env node
/**
 * digby-mcp smoke test — drives the built server (dist/) against a live Digby
 * backend end to end:
 *
 *   1. Logs in (POST /api/auth/login) and mints a full-scope agent token
 *      (POST /api/crossmodel/platform/tokens) — the same credential a user
 *      would create in Account → Developer.
 *   2. STDIO: spawns `node dist/server.js --stdio` with DIGBY_USER_TOKEN and
 *      runs initialize → tools/list → tools/call list_chats → tools/call
 *      list_folders over newline-delimited JSON-RPC.
 *   3. HTTP: spawns `node dist/server.js` on a scratch port and runs
 *      /health → POST /mcp initialize → tools/list → tools/call
 *      list_schedules with the agent token, plus a negative check that a
 *      request with no Authorization header is rejected with 401.
 *   4. Revokes the agent token again (best-effort cleanup).
 *
 * Env overrides: DIGBY_API_URL (default http://localhost:4000),
 * E2E_EMAIL / E2E_PASSWORD (default the e2e@digby.dev seed user).
 *
 * Usage: npm run smoke
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = (process.env.DIGBY_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || 'e2e@digby.dev';
const PASSWORD = process.env.E2E_PASSWORD || 'e2e-password-123';
const HTTP_PORT = 8123;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');

let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => { failures++; console.error(`  ✘ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

// ── REST helpers ────────────────────────────────────────────────────────────

async function rest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── stdio JSON-RPC client ───────────────────────────────────────────────────

function stdioClient(env) {
  const proc = spawn('node', [SERVER, '--stdio'], {
    env: { ...process.env, DIGBY_MCP_TRANSPORT: 'stdio', DIGBY_API_URL: API, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const call = (method, params, id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const close = () => proc.kill('SIGTERM');
  return { call, notify, close };
}

// ── HTTP (StreamableHTTP) client ────────────────────────────────────────────

async function httpRpc(method, params, id, token) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  // StreamableHTTP may answer as SSE ("data: {…}\n\n") or plain JSON.
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
    : text;
  let data = null;
  try { data = JSON.parse(payload); } catch { /* leave null */ }
  return { status: res.status, data, raw: text };
}

// ── main ────────────────────────────────────────────────────────────────────

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'digby-mcp-smoke', version: '1.0.0' },
};

function toolText(rpcResult) {
  const content = rpcResult?.result?.content;
  return Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : '';
}

async function main() {
  console.log(`\ndigby-mcp smoke — API: ${API}\n`);

  // 1. Login + mint agent token ─────────────────────────────────────────────
  console.log('1. Mint a full-scope agent token for the e2e user');
  const login = await rest('POST', `${API}/api/auth/login`, null, { email: EMAIL, password: PASSWORD });
  const jwt = login.data?.data?.accessToken || login.data?.accessToken || login.data?.token;
  check(login.status === 200 && !!jwt, `login ${EMAIL} → HTTP ${login.status}`);
  if (!jwt) throw new Error('no JWT — cannot continue');

  const mint = await rest('POST', `${API}/api/crossmodel/platform/tokens`, jwt, {
    name: `digby-mcp smoke ${Date.now()}`,
    scopes: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'],
  });
  const agentToken = mint.data?.token;
  const tokenId = mint.data?.id;
  check(mint.status === 201 && typeof agentToken === 'string' && agentToken.startsWith('dgt_'),
    `mint agent token → HTTP ${mint.status} (${mint.data?.tokenPrefix || 'no prefix'}…)`);
  if (!agentToken) throw new Error('no agent token — cannot continue');

  // 2. stdio smoke ──────────────────────────────────────────────────────────
  console.log('\n2. stdio transport (DIGBY_USER_TOKEN pass-through)');
  const stdio = stdioClient({ DIGBY_USER_TOKEN: agentToken });
  try {
    const init = await stdio.call('initialize', INITIALIZE_PARAMS, 1);
    check(init?.result?.serverInfo?.name === 'digby', `initialize → server "${init?.result?.serverInfo?.name}"`);
    stdio.notify('notifications/initialized');

    const list = await stdio.call('tools/list', {}, 2);
    const names = (list?.result?.tools || []).map((t) => t.name);
    const expected = [
      'list_chats', 'get_chat_status', 'create_chat', 'send_chat_message', 'start_coding_session',
      'move_chat', 'rename_chat', 'archive_chat', 'delete_chat',
      'list_folders', 'create_folder', 'update_folder', 'move_folder', 'delete_folder',
      'create_schedule', 'list_schedules', 'cancel_schedule',
    ];
    check(expected.every((n) => names.includes(n)), `tools/list → ${names.length} tools, all 17 expected present`);

    const chats = await stdio.call('tools/call', { name: 'list_chats', arguments: { limit: 5 } }, 3);
    check(chats?.result && !chats.result.isError, `tools/call list_chats → ${toolText(chats).split('\n')[0] || 'ok'}`);

    const folders = await stdio.call('tools/call', { name: 'list_folders', arguments: {} }, 4);
    check(folders?.result && !folders.result.isError, `tools/call list_folders → ${toolText(folders).split('\n')[0] || 'ok'}`);
  } finally {
    stdio.close();
  }

  // 3. HTTP smoke ───────────────────────────────────────────────────────────
  console.log('\n3. HTTP transport (Authorization header pass-through)');
  const http = spawn('node', [SERVER], {
    env: { ...process.env, MCP_SERVER_PORT: String(HTTP_PORT), DIGBY_API_URL: API },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    // wait for /health
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`).then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    check(up, '/health responds ok');
    if (!up) throw new Error('HTTP server did not start');

    const noAuth = await httpRpc('initialize', INITIALIZE_PARAMS, 1, null);
    check(noAuth.status === 401, `no Authorization header → HTTP 401 (${noAuth.raw.slice(0, 80)}…)`);

    const init = await httpRpc('initialize', INITIALIZE_PARAMS, 2, agentToken);
    check(init.status === 200 && init.data?.result?.serverInfo?.name === 'digby', `initialize → server "${init.data?.result?.serverInfo?.name}"`);

    const list = await httpRpc('tools/list', {}, 3, agentToken);
    check((list.data?.result?.tools || []).length === 17, `tools/list → ${(list.data?.result?.tools || []).length} tools`);

    const sched = await httpRpc('tools/call', { name: 'list_schedules', arguments: {} }, 4, agentToken);
    const schedText = sched.data?.result ? toolText(sched.data) : '';
    check(sched.status === 200 && sched.data?.result && !sched.data.result.isError,
      `tools/call list_schedules (agent token, schedules:write scope) → ${schedText.split('\n')[0] || 'ok'}`);

    const badToken = await httpRpc('tools/call', { name: 'list_chats', arguments: {} }, 5, 'dgt_deadbeef');
    const badText = toolText(badToken.data);
    check(badToken.data?.result?.isError === true && badText.includes('401'),
      `garbage token → isError tool result with 401 guidance ("${badText.split('\n')[0].slice(0, 90)}…")`);
  } finally {
    http.kill('SIGTERM');
  }

  // 4. cleanup ──────────────────────────────────────────────────────────────
  if (tokenId) {
    const revoke = await rest('DELETE', `${API}/api/crossmodel/platform/tokens/${tokenId}`, jwt);
    check(revoke.status === 200, 'smoke agent token revoked');
  }

  console.log(failures === 0 ? '\nSMOKE OK\n' : `\nSMOKE FAILED (${failures} failure(s))\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSMOKE ERROR: ${err.message}\n`);
  process.exit(1);
});
