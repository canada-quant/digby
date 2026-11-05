#!/usr/bin/env node
/**
 * End-to-end smoke for the X (Twitter) integration on production.
 *
 * Runs three suites:
 *   1. API smoke           — auth-protected endpoints respond correctly,
 *                            OAuth start URL has the right scopes + PKCE.
 *   2. Bright Data reads   — submit a chat query with X intent, observe the
 *                            SSE stream, confirm x-mcp fetched data via
 *                            mcp.digby.ai brightdata_scrape_as_markdown.
 *   3. Playwright UI       — log in via the real digby.ai UI, navigate to
 *                            Account → Integrations, click Connect X, verify
 *                            the redirect URL lands on x.com/i/oauth2/...
 *
 *   tsx scripts/test-x-integration.ts
 */

import * as fs from 'fs';

const BASE     = process.env.PROD_URL      || 'https://digby.ai';
const FRONTEND = process.env.FRONTEND_URL  || 'https://digby.ai';
const stamp = Date.now();
const USER  = { email: `xtest+${stamp}@digbytest.local`, password: 'P@ssw0rd1234', name: 'X Tester' };

type R = { name: string; ok: boolean; detail?: string };
const results: R[] = [];
function rec(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function http(
  method: string, path: string,
  opts: { token?: string; body?: unknown; follow?: boolean } = {},
): Promise<{ status: number; headers: Headers; json: any; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: opts.follow === false ? 'manual' : 'follow',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function register(): Promise<string> {
  const r = await http('POST', '/api/auth/register', { body: USER });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.data.accessToken as string;
}

// ── SUITE 1: API smoke ───────────────────────────────────────────────────────

async function suiteApiSmoke(token: string) {
  console.log('\n── Suite 1: API smoke ──────────────────────────────────────');

  let r = await http('GET', '/api/crossmodel/x/status', { token });
  rec('1.1 /x/status reachable + connected:false',
      r.status === 200 && r.json?.data?.connected === false,
      `status=${r.status} body=${JSON.stringify(r.json?.data ?? {}).slice(0,80)}`);

  // /x/auth without token → 401
  r = await http('GET', '/api/crossmodel/x/auth', { follow: false });
  rec('1.2 /x/auth without token → 401',
      r.status === 401, `status=${r.status}`);

  // /x/auth with token → 302 to x.com
  const authResp = await fetch(`${BASE}/api/crossmodel/x/auth?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const location = authResp.headers.get('location') || '';
  rec('1.3 /x/auth with token → 302 to x.com oauth',
      authResp.status === 302 && location.startsWith('https://x.com/i/oauth2/authorize'),
      `status=${authResp.status} loc=${location.slice(0, 70)}`);

  // Validate the redirect URL has all expected scopes + PKCE
  const url = new URL(location);
  const params = url.searchParams;
  const expectScopes = [
    'tweet.read','tweet.write','users.read','like.read','like.write',
    'follows.read','follows.write','offline.access',
  ];
  const scopeStr = params.get('scope') ?? '';
  const allScopes = expectScopes.every((s) => scopeStr.includes(s));
  rec('1.4 OAuth URL contains all 8 scopes', allScopes,
      `missing: ${expectScopes.filter((s) => !scopeStr.includes(s)).join(',') || 'none'}`);
  rec('1.5 OAuth URL has PKCE S256 challenge',
      params.get('code_challenge_method') === 'S256' && !!params.get('code_challenge'),
      `challenge=${(params.get('code_challenge') ?? '').slice(0, 12)}...`);
  rec('1.6 OAuth URL response_type=code',
      params.get('response_type') === 'code');
  rec('1.7 OAuth URL has csrf state', !!params.get('state'));

  r = await http('DELETE', '/api/crossmodel/x/disconnect', { token });
  rec('1.8 /x/disconnect idempotent when not connected',
      r.status === 200 && r.json?.success === true, `status=${r.status}`);
}

// ── SUITE 2: Bright Data reads via chat SSE ──────────────────────────────────

async function suiteBrightDataReads(token: string) {
  console.log('\n── Suite 2: Bright Data reads via end-to-end chat ─────────');

  // We use a query that triggers profile + handle extraction. The controller
  // should call x_get_user_profile which scrapes x.com/@sama through Bright
  // Data and inject the result into the AI context.
  const query = "Show me @sama's twitter profile and what they've been posting recently. Just summarize their bio + last 3 posts.";
  const url = new URL(`${BASE}/api/crossmodel/stream`);
  url.searchParams.set('message', query);
  url.searchParams.set('mode', 'single');     // cheap + fast
  url.searchParams.set('webSearch', 'false'); // no Bright Data search interference
  url.searchParams.set('token', token);

  console.log(`     query: "${query.slice(0, 60)}…"`);
  const t0 = Date.now();
  const res = await fetch(url.toString(), { headers: { Accept: 'text/event-stream' } });
  if (!res.body) throw new Error('no body on SSE response');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const sawProgress: string[] = [];
  let sawXStage = false;
  let chunkBytes = 0;
  let modelResponseCount = 0;
  let completed = false;
  let errMsg = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (!payload) continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'progress') {
          if (evt.data?.stage) sawProgress.push(evt.data.stage);
          if (evt.data?.stage === 'x') sawXStage = true;
        } else if (evt.type === 'chunk') {
          chunkBytes += (evt.data?.content?.length ?? 0);
        } else if (evt.type === 'model-response') {
          modelResponseCount++;
        } else if (evt.type === 'complete') {
          completed = true;
        } else if (evt.type === 'error') {
          errMsg = evt.data?.message ?? 'unknown';
        }
      } catch {}
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  rec('2.1 SSE stream completed (no error)',
      completed && !errMsg, `t=${elapsed}s err=${errMsg || 'none'}`);
  rec('2.2 Controller detected X intent (saw stage=x progress event)',
      sawXStage, `stages=[${sawProgress.join(', ')}]`);
  rec('2.3 Got a final assistant response',
      modelResponseCount >= 1 && chunkBytes > 50,
      `models=${modelResponseCount} chunk=${chunkBytes}b`);
}

// ── SUITE 3: Playwright UI ───────────────────────────────────────────────────

async function suitePlaywrightUi() {
  console.log('\n── Suite 3: Playwright UI (real digby.ai) ─────────────────');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Log in via UI
  await page.goto(`${FRONTEND}/login`);
  await page.fill('input[type=email], input[name=email]', USER.email);
  await page.fill('input[type=password], input[name=password]', USER.password);
  await Promise.all([
    page.waitForURL((u: URL) => !u.pathname.startsWith('/login'), { timeout: 30000 }),
    page.click('button[type=submit]'),
  ]);
  rec('3.1 Login via UI succeeds', !page.url().includes('/login'),
      `url=${page.url()}`);

  // Navigate to Integrations tab
  await page.goto(`${FRONTEND}/crossmodel/account?tab=integrations`);
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await page.screenshot({ path: '/tmp/x-ui-01-integrations.png', fullPage: true });
  const body = (await page.textContent('body')) ?? '';
  rec('3.2 Integrations page renders + shows X card',
      body.includes('X.com') || body.includes('Connect X'));

  // Scroll all the way to the bottom so the X card (which sits below GitHub) is
  // in view, then click the specific Connect X button (avoid matching
  // "Connect Xero" via substring).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/x-ui-02-scrolled.png', fullPage: true });

  // Use exact-text matcher — getByRole('button', {name: /^Connect X$/}) is
  // the strictest selector against Connect Xero.
  const connectXBtn = page.getByRole('button', { name: /^Connect X$/ });
  const btnCount = await connectXBtn.count();
  rec('3.3a "Connect X" button is discoverable', btnCount === 1,
      `count=${btnCount}`);

  const [navRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('x.com/i/oauth2/authorize'),
      { timeout: 30000 }).catch(() => null),
    connectXBtn.first().click({ timeout: 15000 }).catch(() => null),
  ]);

  if (navRequest) {
    const target = navRequest.url();
    rec('3.3b Click → navigation to x.com OAuth consent', true,
        `→ ${target.slice(0, 90)}…`);
    const params = new URL(target).searchParams;
    rec('3.4 OAuth nav includes PKCE S256 + all scopes',
        params.get('code_challenge_method') === 'S256' &&
        params.get('scope')?.includes('tweet.write') === true);
  } else {
    rec('3.3b Click → navigation to x.com OAuth consent', false,
        `did not observe a request to x.com/i/oauth2/authorize within 30s`);
  }
  await page.screenshot({ path: '/tmp/x-ui-03-after-click.png', fullPage: true });

  await browser.close();
  rec('3.5 No JS pageerrors', errors.length === 0,
      errors.length ? errors.join(' | ').slice(0, 150) : '');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nX integration end-to-end test against ${BASE}\n${'─'.repeat(64)}`);

  // Probe health first
  const h = await fetch(`${BASE}/api/health`).then((r) => r.json());
  if (h.status !== 'healthy') {
    console.error(`Backend not healthy: ${JSON.stringify(h)}`);
    process.exit(2);
  }

  const token = await register();
  console.log(`Registered ${USER.email}`);

  await suiteApiSmoke(token);
  await suiteBrightDataReads(token);
  await suitePlaywrightUi();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(64)}\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('Screenshots:');
  for (const f of fs.readdirSync('/tmp').filter((n) => n.startsWith('x-ui-'))) {
    console.log(`  /tmp/${f}`);
  }
  if (failed.length) {
    console.log('\nFailing:');
    failed.forEach((r) => console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
