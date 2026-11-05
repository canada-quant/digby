/**
 * Live E2E test against https://digby.ai
 * Tests all flows: Frontier/OS × Fast/Thinking × Web Search
 */

import https from 'https';
import http from 'http';

const BASE = 'https://digby.ai/api';

// ── ANSI colours ────────────────────────────────────────────────────────────
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', B = '\x1b[36m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ok  = msg => console.log(`${G}✅${RESET} ${msg}`);
const err = msg => console.log(`${R}❌${RESET} ${msg}`);
const inf = msg => console.log(`${B}ℹ️ ${RESET} ${msg}`);
const hdr = msg => console.log(`\n${Y}${'═'.repeat(60)}${RESET}\n${Y}${msg}${RESET}\n${Y}${'═'.repeat(60)}${RESET}`);

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function put(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── SSE stream reader ────────────────────────────────────────────────────────
function streamQuery(message, mode, webSearch, token, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      message,
      mode,
      webSearch: String(webSearch),
    });
    const url = new URL(BASE + '/crossmodel/stream?' + params.toString());
    const opts = {
      hostname: url.hostname,
      path: url.pathname + '?' + params.toString(),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    };

    const events = { init: null, models: {}, chunks: 0, complete: null, error: null, progress: [] };
    let buf = '';
    const start = Date.now();

    const timeoutId = setTimeout(() => {
      req.destroy();
      reject(new Error(`Stream timed out after ${timeoutMs/1000}s`));
    }, timeoutMs);

    const req = https.request(opts, res => {
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const ev = JSON.parse(raw);
            switch (ev.type) {
              case 'init':    events.init = ev.data; break;
              case 'model':   events.models[ev.data.model] = ev.data; break;
              case 'chunk':   events.chunks++; break;
              case 'complete': events.complete = ev.data; break;
              case 'error':   events.error = ev.data; break;
              case 'progress': events.progress.push(ev.data?.message || ev.data); break;
            }
          } catch {}
        }
      });

      res.on('end', () => {
        clearTimeout(timeoutId);
        events.elapsed = Date.now() - start;
        resolve(events);
      });
      res.on('error', e => { clearTimeout(timeoutId); reject(e); });
    });

    req.on('error', e => { clearTimeout(timeoutId); reject(e); });
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────
async function runTest(label, token, modelSet, mode, message, webSearch = false, timeoutMs = 180000) {
  process.stdout.write(`  ${DIM}[${modelSet}/${mode}${webSearch?' +search':''}] ${message.slice(0,60)}...${RESET} `);
  const t = Date.now();
  try {
    const ev = await streamQuery(message, mode, webSearch, token, timeoutMs);
    const elapsed = Date.now() - t;

    if (ev.error) {
      err(`ERROR after ${elapsed}ms — ${JSON.stringify(ev.error).slice(0,120)}`);
      return { ok: false, elapsed, error: ev.error };
    }
    if (!ev.complete) {
      err(`NO COMPLETE event after ${elapsed}ms (${ev.chunks} chunks)`);
      return { ok: false, elapsed, error: 'no complete event' };
    }

    const summaryLen = ev.complete?.synthesis?.length || ev.complete?.summary?.length || 0;
    const followups  = ev.complete?.followUps?.length || 0;
    const modelCount = Object.keys(ev.models).length;

    // Check for model-level errors
    const modelErrors = Object.entries(ev.models)
      .filter(([,v]) => v.error)
      .map(([k,v]) => `${k}: ${v.error?.slice?.(0,60) || v.error}`);

    if (modelErrors.length > 0) {
      console.log(`${Y}⚠️ ${RESET} ${elapsed}ms | ${modelCount} models (${modelErrors.length} errors) | summary=${summaryLen}ch | followups=${followups}`);
      modelErrors.forEach(e => console.log(`      ${R}model error: ${e}${RESET}`));
    } else {
      ok(`${elapsed}ms | ${modelCount} models OK | summary=${summaryLen}ch | followups=${followups}`);
    }

    // Print model timings
    for (const [name, m] of Object.entries(ev.models)) {
      const modelId = m.modelUsed?.split('/').pop() || m.modelUsed || name;
      const status = m.error ? `${R}ERROR: ${m.error?.slice?.(0,50)}${RESET}` : `${G}${m.time}ms${RESET}`;
      console.log(`    ${DIM}  ↳ ${name} (${modelId}): ${RESET}${status}`);
    }

    return { ok: true, elapsed, summaryLen, followups, modelErrors };
  } catch (e) {
    err(`EXCEPTION after ${Date.now()-t}ms — ${e.message}`);
    return { ok: false, elapsed: Date.now()-t, error: e.message };
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${B}🧪 digby.ai Live E2E Test Suite${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Time: ${new Date().toISOString()}${RESET}\n`);

  const results = [];
  let pass = 0, fail = 0;

  // ── 1. AUTH FLOW ───────────────────────────────────────────────────────────
  hdr('1. AUTH FLOW');

  // Login with test account
  inf('Logging in as cline@digby.ai...');
  const loginRes = await post('/auth/login', { email: 'cline@digby.ai', password: 'ClneTest2026!' });
  if (!loginRes.body?.success) {
    err(`Login FAILED: ${JSON.stringify(loginRes.body)}`);
    process.exit(1);
  }
  const TOKEN = loginRes.body.data.accessToken;
  ok(`Login OK — token obtained`);

  // Wrong credentials
  inf('Testing wrong credentials error message...');
  const badLogin = await post('/auth/login', { email: 'cline@digby.ai', password: 'wrong' });
  if (badLogin.status === 401 && badLogin.body?.message?.toLowerCase().includes('invalid')) {
    ok(`Wrong credentials → 401 + correct error message`);
  } else {
    err(`Wrong credentials → unexpected: ${badLogin.status} ${JSON.stringify(badLogin.body?.message)}`);
  }

  // Get user profile
  inf('Fetching user profile...');
  const profile = await get('/auth/me', TOKEN);
  if (profile.status === 200 && profile.body?.success) {
    ok(`GET /auth/me → 200 (${profile.body.data?.email})`);
  } else {
    err(`GET /auth/me → ${profile.status}`);
  }

  // ── 2. PREFERENCES ─────────────────────────────────────────────────────────
  hdr('2. PREFERENCES API');

  inf('Getting current preferences...');
  const prefs = await get('/crossmodel/preferences', TOKEN);
  if (prefs.status === 200) {
    ok(`GET preferences → 200 (modelSet=${prefs.body.data?.modelSet})`);
  } else {
    err(`GET preferences → ${prefs.status}`);
  }

  // ── 3. FRONTIER FAST MODE ─────────────────────────────────────────────────
  hdr('3. FRONTIER FAST MODE');
  await put('/crossmodel/preferences', { modelSet: 'frontier' }, TOKEN);

  const testsFrontierFast = [
    { msg: 'What is 2 + 2?', web: false },
    { msg: 'Explain the difference between TCP and UDP in one paragraph', web: false },
    { msg: 'What are the latest AI news headlines today?', web: true },
  ];

  for (const t of testsFrontierFast) {
    const r = await runTest('frontier/fast', TOKEN, 'frontier', 'fast', t.msg, t.web, 60000);
    results.push({ test: `frontier/fast: ${t.msg.slice(0,40)}`, ...r });
    r.ok ? pass++ : fail++;
  }

  // ── 4. FRONTIER THINKING MODE ─────────────────────────────────────────────
  hdr('4. FRONTIER THINKING MODE');

  const testsFrontierThinking = [
    { msg: 'What is the philosophical argument for determinism?', web: false },
    { msg: 'Compare monolithic vs microservices architectures', web: false },
  ];

  for (const t of testsFrontierThinking) {
    const r = await runTest('frontier/thinking', TOKEN, 'frontier', 'thinking', t.msg, t.web, 90000);
    results.push({ test: `frontier/thinking: ${t.msg.slice(0,40)}`, ...r });
    r.ok ? pass++ : fail++;
  }

  // ── 5. OPEN SOURCE FAST MODE ───────────────────────────────────────────────
  hdr('5. OPEN SOURCE FAST MODE');
  await put('/crossmodel/preferences', { modelSet: 'open_source' }, TOKEN);

  const testsOSFast = [
    { msg: 'What is 2 + 2?', web: false },
    { msg: 'Explain REST vs GraphQL', web: false },
    { msg: 'What is the latest news in AI today?', web: true },
  ];

  for (const t of testsOSFast) {
    const r = await runTest('open_source/fast', TOKEN, 'open_source', 'fast', t.msg, t.web, 90000);
    results.push({ test: `OS/fast: ${t.msg.slice(0,40)}`, ...r });
    r.ok ? pass++ : fail++;
  }

  // ── 6. OPEN SOURCE THINKING MODE (kimi-k2p5 now!) ─────────────────────────
  hdr('6. OPEN SOURCE THINKING MODE (kimi-k2p5 validator)');

  const testsOSThinking = [
    { msg: 'Explain quantum entanglement and its implications for computing', web: false },
    { msg: 'What makes a distributed system truly fault-tolerant?', web: false },
  ];

  for (const t of testsOSThinking) {
    const r = await runTest('open_source/thinking', TOKEN, 'open_source', 'thinking', t.msg, t.web, 180000);
    results.push({ test: `OS/thinking: ${t.msg.slice(0,40)}`, ...r });
    r.ok ? pass++ : fail++;
  }

  // ── 7. CHAT CRUD ─────────────────────────────────────────────────────────
  hdr('7. CHAT CRUD API');
  inf('Creating a new chat...');
  const createChat = await post('/crossmodel/chats', { title: 'Test Chat', messages: [] }, TOKEN);
  if (createChat.status === 201 && createChat.body?.success) {
    const chatId = createChat.body.data?.id;
    ok(`POST /chats → 201 (id=${chatId?.slice(0,8)})`);

    // List chats
    const listChats = await get('/crossmodel/chats?page=1&limit=5', TOKEN);
    if (listChats.status === 200) {
      ok(`GET /chats → 200 (${listChats.body.data?.length} chats)`);
    } else {
      err(`GET /chats → ${listChats.status}`);
    }

    // Delete the test chat
    if (chatId) {
      const delRes = await new Promise(resolve => {
        const url = new URL(BASE + `/crossmodel/chats/${chatId}`);
        const req = https.request({
          hostname: url.hostname, path: url.pathname, method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` }
        }, res => { resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.end();
      });
      delRes === 200 ? ok(`DELETE /chats/${chatId.slice(0,8)} → 200`) : err(`DELETE chat → ${delRes}`);
    }
  } else {
    err(`POST /chats → ${createChat.status}: ${JSON.stringify(createChat.body)}`);
  }

  // ── 8. MEMORY API ────────────────────────────────────────────────────────
  hdr('8. USER MEMORY API');
  const memRes = await get('/crossmodel/memory', TOKEN);
  if (memRes.status === 200) {
    const factCount = Object.keys(memRes.body.data?.facts || {}).length;
    ok(`GET /memory → 200 (${factCount} facts stored)`);
  } else {
    err(`GET /memory → ${memRes.status}`);
  }

  // ── 9. PROJECTS API ──────────────────────────────────────────────────────
  hdr('9. PROJECTS API');
  const projRes = await get('/crossmodel/projects', TOKEN);
  if (projRes.status === 200) {
    ok(`GET /projects → 200 (${projRes.body.data?.length || 0} projects)`);
  } else {
    err(`GET /projects → ${projRes.status}`);
  }

  // ── 10. CANVAS API ───────────────────────────────────────────────────────
  hdr('10. CANVAS API');
  const canvasRes = await get('/crossmodel/canvases', TOKEN);
  if (canvasRes.status === 200) {
    ok(`GET /canvases → 200 (${canvasRes.body.data?.length || 0} canvases)`);
  } else {
    err(`GET /canvases → ${canvasRes.status}`);
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  hdr('TEST SUMMARY');
  console.log(`\n${G}PASSED: ${pass}${RESET}  ${R}FAILED: ${fail}${RESET}  Total: ${pass + fail}\n`);

  console.log('Stream test results:');
  for (const r of results) {
    const icon = r.ok ? `${G}✅${RESET}` : `${R}❌${RESET}`;
    const timing = r.elapsed ? `${r.elapsed}ms` : '';
    console.log(`  ${icon} ${r.test.padEnd(55)} ${timing}`);
  }

  if (fail > 0) {
    console.log(`\n${R}⚠️  ${fail} test(s) FAILED — see details above${RESET}`);
  } else {
    console.log(`\n${G}🎉 All tests PASSED!${RESET}`);
  }
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
