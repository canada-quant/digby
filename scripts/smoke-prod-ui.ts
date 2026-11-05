#!/usr/bin/env node
/**
 * Lightweight production UI smoke. Walks 5 of the publicly-reachable pages
 * with a headless browser, captures screenshots, asserts no JS pageerrors,
 * and reports the rendered title/headline text.
 *
 *   tsx scripts/smoke-prod-ui.ts
 *
 * Screenshots: /tmp/prod-ui-*.png
 */

const BASE = process.env.PROD_URL || 'https://digby.ai';

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`\nProduction UI smoke — ${BASE}\n${'─'.repeat(60)}`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  // ── 1. Health endpoint ────────────────────────────────────────────────────
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  record('1. /api/health is healthy', health.status === 'healthy',
    `db=${health.db} redis=${health.redis} uptime=${Math.round(health.uptime ?? 0)}s`);

  // ── 2. Landing / root ─────────────────────────────────────────────────────
  await page.goto(BASE);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/prod-ui-01-landing.png', fullPage: true });
  const landingTitle = await page.title();
  record('2. Landing page renders', landingTitle.length > 0, `title="${landingTitle}"`);

  // ── 3. Login page ─────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/prod-ui-02-login.png', fullPage: true });
  const hasEmailInput = (await page.locator('input[type=email], input[name=email]').count()) > 0;
  record('3. /login renders with email input', hasEmailInput);

  // ── 4. Public share page (bogus token — should show "not found"/landing) ──
  await page.goto(`${BASE}/crossmodel/shared/chat/bogus-token-${Date.now()}`);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/prod-ui-03-share-bogus.png', fullPage: true });
  const shareBody = await page.textContent('body') ?? '';
  // Should render *something* meaningful — not a raw 500/error.
  record('4. Public share route renders gracefully',
    shareBody.length > 50 && !/internal server error/i.test(shareBody),
    `bodyChars=${shareBody.length}`);

  // ── 5. Probe an authenticated route — should redirect to login ────────────
  const r = await page.goto(`${BASE}/crossmodel`);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/prod-ui-04-crossmodel.png', fullPage: true });
  const url = page.url();
  // Either renders crossmodel UI (if any anon session cookie tricks it) or
  // bounces to /login — both are acceptable. We only check the page is alive.
  record('5. /crossmodel route alive (no 5xx)', r !== null && (r.status() < 500),
    `status=${r?.status()} url=${url}`);

  // ── JS pageerrors ─────────────────────────────────────────────────────────
  record('6. No JS pageerrors during smoke',
    jsErrors.length === 0,
    jsErrors.length ? jsErrors.join(' | ').slice(0, 200) : '');

  await browser.close();

  console.log(`\n${'─'.repeat(60)}\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed`);
  console.log('Screenshots in /tmp/prod-ui-*.png');
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
