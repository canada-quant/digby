/**
 * Service tests — run with `node --test dist/core.test.js` INSIDE the
 * browser-service image (it has Node 20; the backend jest chain does not own
 * this directory). Uses a FAKE Playwright module: no Chromium, hermetic.
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
// Node's built-in test runner types come from @types/node@20 — the global
// `test` exists at RUNTIME (node --test) but the tsconfig pins types:["node"]
// which excludes it in older @types/node; declare the shape we use.
import { test } from 'node:test';
import { BrowserContextManager, createServer, executeAction, extractLinks, htmlToText } from './core';

// ── fake playwright ──────────────────────────────────────────────────────────

class FakePage {
  urlValue = 'about:blank';
  contentValue = '<html><body><h1>Hello</h1><a href="https://x.test/a">Link A</a></body></html>';
  clicks: string[] = [];
  fills: Array<{ sel: string; text: string }> = [];
  evaluates: string[] = [];
  closed = false;
  async goto(u: string) { this.urlValue = u; return null; }
  async content() { return this.contentValue; }
  async title() { return 't'; }
  url() { return this.urlValue; }
  async close() { this.closed = true; }
  async click(sel: string) { this.clicks.push(sel); }
  async fill(sel: string, text: string) { this.fills.push({ sel, text }); }
  async press(sel: string) { this.clicks.push(`${sel}:Enter`); }
  async evaluate(fn: string) { this.evaluates.push(fn); return null; }
  async screenshot() { return Buffer.from('png'); }
  async setViewportSize() { /* noop */ }
}

class FakeContext {
  pages: FakePage[] = [];
  stateSaved: string | null = null;
  closed = false;
  async newPage() { const p = new FakePage(); this.pages.push(p); return p as any; }
  async storageState(opts?: { path?: string }) {
    if (opts?.path) { fs.mkdirSync(path.dirname(opts.path), { recursive: true }); fs.writeFileSync(opts.path, JSON.stringify({ cookies: [], origins: [] })); this.stateSaved = opts.path; }
    return { cookies: [], origins: [] };
  }
  async close() { this.closed = true; }
}

class FakeBrowser {
  contexts: FakeContext[] = [];
  closed = false;
  async newContext(opts?: any) {
    assert.ok(!('storageState' in opts) || typeof opts.storageState === 'string', 'storageState must be a path');
    if (typeof opts?.storageState === 'string') {
      let raw = '';
      try { raw = fs.readFileSync(opts.storageState, 'utf8'); } catch { /* missing file → fresh */ }
      if (raw) {
        try { JSON.parse(raw); } catch {
          throw new Error(`Playwright: Failed to load storage state from ${opts.storageState}: unexpected token`);
        }
      }
    }
    const c = new FakeContext(); this.contexts.push(c); return c as any;
  }
  async close() { this.closed = true; }
}

const fakeBrowser = new FakeBrowser();
const fakePlaywright = { chromium: { launch: async () => fakeBrowser as any } };

const SECRET = 'test-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsvc-'));

function newMgr(over: Partial<ConstructorParameters<typeof BrowserContextManager>[0]> = {}) {
  return new BrowserContextManager({
    port: 0, secret: SECRET, dataDir, contextsMax: 2, idleMs: 60_000, playwright: fakePlaywright, ...over,
  });
}

// ── unit: tokens ─────────────────────────────────────────────────────────────

test('tokenFor is deterministic and key-scoped', () => {
  const m = newMgr();
  const t1 = m.tokenFor('sess-a');
  assert.strictEqual(t1, m.tokenFor('sess-a'));
  assert.notStrictEqual(t1, m.tokenFor('sess-b'));
  assert.strictEqual(t1.length, 64);
});

test('verifyToken accepts the right token, rejects others (constant-time path)', () => {
  const m = newMgr();
  const t = m.tokenFor('sess-a');
  assert.strictEqual(m.verifyToken('sess-a', t), true);
  assert.strictEqual(m.verifyToken('sess-a', `Bearer ${t}`), false, 'raw header value only');
  assert.strictEqual(m.verifyToken('sess-b', t), false, 'cross-session token rejected');
  assert.strictEqual(m.verifyToken('sess-a', undefined), false);
  assert.strictEqual(m.verifyToken('sess-a', t.toUpperCase()), false);
});

test('R1: empty secret = INERT — no token can be forged, nothing verifies', async () => {
  const m = newMgr({ secret: '' });
  assert.strictEqual(m.tokenFor('sess-a'), '', 'empty secret yields no token');
  // The attack from the re-review: forge the empty-key HMAC digest.
  const forged = crypto.createHmac('sha256', '').update('ctx:sess-a').digest('hex');
  assert.strictEqual(m.verifyToken('sess-a', forged), false, 'forged empty-key token REJECTED');
  assert.strictEqual(m.verifyToken('sess-a', ''), false, 'empty presentation rejected');
  // End-to-end: /health stays 200 but /v1/action 401s even with the forged token.
  const { server, port } = await withServer(m);
  try {
    const res = await post(port, '/v1/action', { sessionId: 'sess-a', action: { name: 'navigate', url: 'https://example.com/' } }, forged);
    assert.strictEqual(res.code, 401, `forged token got through: ${res.code}`);
  } finally {
    server.close();
    await m.closeAll();
  }
});

// ── unit: context lifecycle ──────────────────────────────────────────────────

test('ensureContext gives ONE context per key, persists storage state to disk', async () => {
  const m = newMgr();
  const c1 = await m.ensureContext('k1');
  const c2 = await m.ensureContext('k1');
  assert.strictEqual(c1, c2, 'same live context');
  await m.persist('k1');
  assert.ok(fs.existsSync(m.statePath('k1')), 'state file written');
  const raw = JSON.parse(fs.readFileSync(m.statePath('k1'), 'utf8'));
  assert.ok(raw && typeof raw === 'object' && 'cookies' in raw);
});

test('context key is hashed into the state filename (ids never become paths)', () => {
  const m = newMgr();
  const p = m.statePath('../../etc/passwd');
  assert.ok(!p.includes('..'), `path traversal escaped: ${p}`);
  assert.match(path.basename(p), /^ctx-[0-9a-f]{32}\.json$/);
});

test('contextsMax is enforced by LRU eviction', async () => {
  const m = newMgr({ contextsMax: 2 });
  await m.ensureContext('a');
  await new Promise((r) => setTimeout(r, 5));
  await m.ensureContext('b');
  await new Promise((r) => setTimeout(r, 5));
  await m.ensureContext('c'); // evicts 'a' (oldest lastUsed)
  const s = m.stats();
  assert.strictEqual(s.contexts, 2, 'cap holds at 2');
  const again = await m.ensureContext('a'); // re-created fresh (state file if any)
  assert.ok(again, 'evicted key can be re-created');
  assert.strictEqual(m.stats().contexts, 2, 'cap still holds after re-create');
});

test('closeContext persists before closing', async () => {
  const m = newMgr();
  await m.ensureContext('k');
  await m.closeContext('k');
  assert.ok(fs.existsSync(m.statePath('k')));
  assert.strictEqual(m.stats().contexts, 0);
});

test('a CORRUPT persisted state file is deleted and the context retried fresh (review M1)', async () => {
  const m = newMgr();
  const bad = m.statePath('corrupt-key');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(bad, '{ this is not valid json !!!');
  // FakeContext throws when storageState is the corrupt file, succeeds fresh.
  const live = await m.ensureContext('corrupt-key');
  assert.ok(live, 'context created despite corrupt state');
  assert.strictEqual(fs.existsSync(bad), false, 'corrupt state file deleted');
  assert.strictEqual(m.stats().contexts, 1);
});

test('R2: a TRANSIENT newContext failure does NOT delete a good state file', async () => {
  const m = newMgr();
  const good = m.statePath('transient-key');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(good, JSON.stringify({ cookies: [{ name: 'session', value: 'secret-cookie' }], origins: [] }));
  // One transient failure whose message does NOT name the storage state.
  let failOnce = true;
  const origLaunch = fakePlaywright.chromium.launch;
  class TransientBrowser extends FakeBrowser {
    async newContext(opts?: any) {
      if (failOnce) { failOnce = false; throw new Error('Target page, context or browser has been closed'); }
      return super.newContext(opts);
    }
  }
  const tb = new TransientBrowser();
  (m as any).cfg = { ...(m as any).cfg };
  // Rebuild a manager sharing the same dataDir but the transient browser.
  const m2 = new BrowserContextManager({ port: 0, secret: SECRET, dataDir, contextsMax: 2, idleMs: 60_000, playwright: { chromium: { launch: async () => tb } } });
  await assert.rejects(() => m2.ensureContext('transient-key'), /browser has been closed/);
  assert.strictEqual(fs.existsSync(good), true, 'good state file SURVIVED the transient failure');
  const live = await m2.ensureContext('transient-key');
  assert.ok(live, 'retry after transient failure succeeds with the state intact');
});

test('concurrent ensureContext for the same key shares ONE context (review M2)', async () => {
  const m = newMgr();
  const [a, b, c] = await Promise.all([
    m.ensureContext('race-key'),
    m.ensureContext('race-key'),
    m.ensureContext('race-key'),
  ]);
  assert.strictEqual(a, b, 'second caller got the same live context');
  assert.strictEqual(b, c, 'third caller got the same live context');
  assert.strictEqual(m.stats().contexts, 1, 'exactly one live context exists');
});

test('R3: concurrent DISTINCT keys cannot overshoot contextsMax (async create window)', async () => {
  // The re-review probe: 4 distinct keys racing at cap 2 previously produced
  // 5 live contexts (each passed the pre-create check before any live.set).
  // Now: 2 succeed, the rest REJECT with the capacity error (design: reject
  // rather than overshoot; the idle reaper + LRU free slots continuously).
  const m = newMgr({ contextsMax: 2 });
  const results = await Promise.allSettled([
    m.ensureContext('d1'),
    m.ensureContext('d2'),
    m.ensureContext('d3'),
    m.ensureContext('d4'),
  ]);
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.strictEqual(m.stats().contexts, 2, `cap overshot: ${m.stats().contexts} live`);
  assert.strictEqual(okCount, 2, `expected 2 fulfilled, got ${okCount}`);
  assert.strictEqual(rejected.length, 2, `expected 2 rejected, got ${rejected.length}`);
  assert.match(rejected[0].reason.message, /at capacity/, 'rejection carries the capacity error');
  // A later request (slots freed or same key) still works.
  const again = await m.ensureContext('d1');
  assert.ok(again, 'existing key still served after capacity rejections');
});

test('stats() exposes the COUNT only — no session keys (review M3)', () => {
  const m = newMgr();
  const s = m.stats() as Record<string, unknown>;
  assert.ok(!('keys' in s), 'no keys field on the unauthenticated /health payload');
  assert.strictEqual(s.contexts, 0);
});

test('scroll amount is NaN/garbage-safe and clamped (review LOW)', async () => {
  const m = newMgr();
  await executeAction(m, { sessionId: 'scroll1', action: { name: 'navigate', url: 'https://example.com/' } });
  const out = await executeAction(m, { sessionId: 'scroll1', action: { name: 'scroll', direction: 'down', amount: Number('800px') } });
  assert.strictEqual(out.ok, true);
  const page = await m.pageFor('scroll1') as unknown as FakePage;
  assert.strictEqual(page.evaluates.length, 1);
  assert.ok(!page.evaluates[0].includes('NaN'), `scrollBy saw NaN: ${page.evaluates[0]}`);
});

// ── unit: actions ────────────────────────────────────────────────────────────

test('executeAction navigate + get_content roundtrip, text extraction + links', async () => {
  const m = newMgr();
  const nav = await executeAction(m, { sessionId: 's1', action: { name: 'navigate', url: 'https://example.com/' } });
  assert.strictEqual(nav.ok, true);
  assert.strictEqual(nav.url, 'https://example.com/');
  const read = await executeAction(m, { sessionId: 's1', action: { name: 'get_content' } });
  assert.strictEqual(read.ok, true);
  assert.ok(read.content!.includes('Hello'));
  assert.strictEqual(read.links?.length, 1);
  assert.strictEqual(read.links?.[0].href, 'https://x.test/a');
});

test('executeAction rejects non-http(s) urls and bad payloads', async () => {
  const m = newMgr();
  const bad = await executeAction(m, { sessionId: 's1', action: { name: 'navigate', url: 'file:///etc/passwd' } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error!, /http\(s\) url/);
  const noSel = await executeAction(m, { sessionId: 's1', action: { name: 'click' } });
  assert.strictEqual(noSel.ok, false);
  const unknown = await executeAction(m, { sessionId: 's1', action: { name: 'hover' } });
  assert.strictEqual(unknown.ok, false);
});

test('executeAction click/type/scroll hit the page API and persist', async () => {
  const m = newMgr();
  await executeAction(m, { sessionId: 's2', action: { name: 'navigate', url: 'https://example.com/' } });
  await executeAction(m, { sessionId: 's2', action: { name: 'type', selector: '#q', text: 'digby', submit: true } });
  await executeAction(m, { sessionId: 's2', action: { name: 'click', selector: '#go' } });
  await executeAction(m, { sessionId: 's2', action: { name: 'scroll', direction: 'down', amount: 400 } });
  const page = await m.pageFor('s2') as unknown as FakePage;
  assert.deepStrictEqual(page.fills, [{ sel: '#q', text: 'digby' }]);
  assert.ok(page.clicks.includes('#go'));
  assert.ok(page.clicks.includes('#q:Enter'), 'submit presses Enter');
  assert.strictEqual(page.evaluates.length, 1);
  assert.ok(fs.existsSync(m.statePath('s2')));
});

test('content is clipped at 8000 chars with truncated flag', async () => {
  const m = newMgr();
  class BigPage extends FakePage { async content() { return 'x'.repeat(50_000); } }
  const live = await m.ensureContext('big');
  live.page = new BigPage() as any;
  const out = await executeAction(m, { sessionId: 'big', action: { name: 'get_content' } });
  assert.strictEqual(out.ok, true);
  assert.ok(out.content!.length < 9000);
  assert.strictEqual(out.truncated, true);
});

test('action errors are captured as ok:false with a message', async () => {
  const m = newMgr();
  class ErrPage extends FakePage { async click() { throw new Error('boom at selector'); } }
  const live = await m.ensureContext('err');
  live.page = new ErrPage() as any;
  const out = await executeAction(m, { sessionId: 'err', action: { name: 'click', selector: '#x' } });
  assert.strictEqual(out.ok, false);
  assert.match(out.error!, /boom/);
});

// ── http: auth + happy path ──────────────────────────────────────────────────

async function withServer(m: BrowserContextManager): Promise<{ server: http.Server; port: number }> {
  const server = createServer(m);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address() as { port: number };
  return { server, port: addr.port };
}

function post(port: number, p: string, body: unknown, token?: string): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ code: res.statusCode!, json: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('HTTP: /v1/action 401s without/with-wrong token, works with the right one', async () => {
  const m = newMgr();
  const { server, port } = await withServer(m);
  try {
    const noTok = await post(port, '/v1/action', { sessionId: 'http1', action: { name: 'navigate', url: 'https://example.com/' } });
    assert.strictEqual(noTok.code, 401);
    const wrong = await post(port, '/v1/action', { sessionId: 'http1', action: { name: 'navigate', url: 'https://example.com/' } }, m.tokenFor('OTHER'));
    assert.strictEqual(wrong.code, 401);
    const ok = await post(port, '/v1/action', { sessionId: 'http1', action: { name: 'navigate', url: 'https://example.com/' } }, m.tokenFor('http1'));
    assert.strictEqual(ok.code, 200);
    assert.strictEqual(ok.json.ok, true);
  } finally {
    server.close();
    await m.closeAll();
  }
});

test('HTTP: /health, 404, invalid json, missing fields', async () => {
  const m = newMgr();
  const { server, port } = await withServer(m);
  try {
    const health = await new Promise<{ code: number; body: any }>((res, rej) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => res({ code: r.statusCode!, body: JSON.parse(raw) }));
      }).on('error', rej);
    });
    assert.strictEqual(health.code, 200);
    assert.strictEqual(health.body.service, 'digby-browser-service');

    const nf = await post(port, '/nope', {});
    assert.strictEqual(nf.code, 404);

    const bad = await new Promise<{ code: number }>((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/action', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } }, (r) => { r.resume(); r.on('end', () => res({ code: r.statusCode! })); });
      req.on('error', rej);
      req.end('{not json');
    });
    assert.strictEqual(bad.code, 400);

    const missing = await post(port, '/v1/action', { sessionId: '', action: { name: 'navigate' } }, m.tokenFor('x'));
    assert.strictEqual(missing.code, 400);
  } finally {
    server.close();
    await m.closeAll();
  }
});

test('HTTP: /v1/close closes the context (persisted) and is token-gated', async () => {
  const m = newMgr();
  const { server, port } = await withServer(m);
  try {
    await post(port, '/v1/action', { sessionId: 'c1', action: { name: 'navigate', url: 'https://example.com/' } }, m.tokenFor('c1'));
    const unauth = await post(port, '/v1/close', { sessionId: 'c1' }, m.tokenFor('nope'));
    assert.strictEqual(unauth.code, 401);
    const closed = await post(port, '/v1/close', { sessionId: 'c1' }, m.tokenFor('c1'));
    assert.strictEqual(closed.code, 200);
    assert.strictEqual(m.stats().contexts, 0);
    assert.ok(fs.existsSync(m.statePath('c1')));
  } finally {
    server.close();
    await m.closeAll();
  }
});

test('htmlToText strips scripts/styles, unescapes entities', () => {
  const text = htmlToText('<p>a &amp; b</p><script>alert(1)</script><style>.x{}</style><noscript>ns</noscript><!-- c --><div>c&lt;d</div>');
  assert.ok(text.includes('a & b'));
  assert.ok(text.includes('c<d'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('.x{}'));
  assert.ok(!text.includes('ns'));
});

test('extractLinks caps at 50 and pulls href + text', () => {
  const many = Array.from({ length: 80 }, (_, i) => `<a href="https://t.test/${i}">L${i}</a>`).join('');
  const links = extractLinks(many);
  assert.strictEqual(links.length, 50);
  assert.strictEqual(links[0].href, 'https://t.test/0');
});
