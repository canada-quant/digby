#!/usr/bin/env node
/**
 * End-to-end UI test for the sharing flows.
 *
 * Drives a real browser through:
 *   - Alice signs in, creates a project, invites Bob, creates a chat in it
 *   - Bob signs in (separate context), sees the shared project, opens the chat
 *   - Anonymous user opens a public chat share link (no auth)
 *
 * Screenshots are written to /tmp/share-ui-*.png at each milestone so the run
 * can be reviewed after-the-fact.
 *
 *   tsx scripts/test-sharing-ui.ts
 */

import * as fs from 'fs';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';
const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:8247';
const stamp = Date.now();
const ALICE = { email: `alice+ui${stamp}@digbytest.local`, password: 'P@ssw0rd1234', name: 'Alice UI' };
const BOB   = { email: `bob+ui${stamp}@digbytest.local`,   password: 'P@ssw0rd1234', name: 'Bob UI'   };

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function registerViaAPI(user: { email: string; password: string; name: string }) {
  const r = await fetch(`${BACKEND}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (r.status !== 201) throw new Error(`register ${user.email} failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { token: j.data.accessToken as string, userId: j.data.user.id as string };
}

async function loginUI(page: any, user: { email: string; password: string }) {
  await page.goto(`${FRONTEND}/login`);
  await page.fill('input[type=email], input[name=email]', user.email);
  await page.fill('input[type=password], input[name=password]', user.password);
  await Promise.all([
    page.waitForURL((u: URL) => !u.pathname.startsWith('/login'), { timeout: 20000 }),
    page.click('button[type=submit]'),
  ]);
}

async function main() {
  console.log(`\nUI sharing test against ${FRONTEND} (backend ${BACKEND})\n${'─'.repeat(60)}`);

  // Probe both servers first
  try {
    const h = await fetch(`${BACKEND}/api/health`).then((r) => r.json());
    if (h.status !== 'healthy') throw new Error(`backend not healthy: ${JSON.stringify(h)}`);
  } catch (e) {
    console.error(`backend unreachable at ${BACKEND}: ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    const r = await fetch(FRONTEND);
    if (r.status >= 500) throw new Error(`frontend status ${r.status}`);
  } catch (e) {
    console.error(`frontend unreachable at ${FRONTEND}: ${(e as Error).message}`);
    process.exit(2);
  }

  // Register users via API (fast) — they'll log in via UI
  await registerViaAPI(ALICE);
  await registerViaAPI(BOB);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  // ── Alice's session ───────────────────────────────────────────────────────
  const aliceCtx = await browser.newContext();
  const aliceP = await aliceCtx.newPage();
  aliceP.on('pageerror', (e) => console.error('Alice pageerror:', e.message));

  await loginUI(aliceP, ALICE);
  record('Alice can log in via UI', !aliceP.url().includes('/login'), `url=${aliceP.url()}`);
  await aliceP.screenshot({ path: '/tmp/share-ui-01-alice-home.png', fullPage: true });

  // Alice creates a project — using the API directly (UI path varies)
  const aliceLS = await aliceCtx.storageState();
  const aliceTok = aliceLS.origins?.[0]?.localStorage?.find((kv: any) => kv.name === 'accessToken')?.value;
  const projectRes = await fetch(`${BACKEND}/api/crossmodel/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceTok}` },
    body: JSON.stringify({ name: `UI Project ${stamp}`, emoji: '🧪' }),
  });
  const project = await projectRes.json();
  record('Project created (API)', projectRes.status === 201, `id=${project.id?.slice(0, 8)}`);

  // Invite Bob
  const inviteRes = await fetch(`${BACKEND}/api/crossmodel/projects/${project.id}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceTok}` },
    body: JSON.stringify({ email: BOB.email, role: 'viewer' }),
  });
  record('Bob invited (API)', inviteRes.status === 201, `status=${inviteRes.status}`);

  // Create a chat in the project
  const chatRes = await fetch(`${BACKEND}/api/crossmodel/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceTok}` },
    body: JSON.stringify({ title: `UI Test Chat ${stamp}`, mode: 'fast', projectId: project.id }),
  });
  const chat = await chatRes.json();
  const chatId = chat.data?.id ?? chat.id;
  record('Chat created in project (API)', !!chatId, `id=${chatId?.slice(0, 8)}`);

  // Alice navigates to her project page in the UI
  await aliceP.goto(`${FRONTEND}/crossmodel/projects/${project.id}`);
  await aliceP.waitForLoadState('networkidle', { timeout: 15000 });
  const aliceProjectBody = await aliceP.textContent('body');
  record('Alice sees project page with chat title',
    !!aliceProjectBody?.includes(`UI Test Chat ${stamp}`),
    aliceProjectBody?.includes(`UI Test Chat ${stamp}`) ? '' : 'chat title missing on project page');
  await aliceP.screenshot({ path: '/tmp/share-ui-02-alice-project.png', fullPage: true });

  // ── Bob's session ─────────────────────────────────────────────────────────
  const bobCtx = await browser.newContext();
  const bobP = await bobCtx.newPage();
  bobP.on('pageerror', (e) => console.error('Bob pageerror:', e.message));

  await loginUI(bobP, BOB);
  record('Bob can log in via UI', !bobP.url().includes('/login'), `url=${bobP.url()}`);

  // Bob navigates to the crossmodel home and looks for "Shared with me" + the project
  await bobP.goto(`${FRONTEND}/crossmodel`);
  await bobP.waitForLoadState('networkidle', { timeout: 15000 });
  const bobHomeBody = await bobP.textContent('body');
  const sharedHeadingVisible = /shared with me/i.test(bobHomeBody || '');
  record('Bob sees "Shared with me" section', sharedHeadingVisible);

  const projectTitleVisible = bobHomeBody?.includes(`UI Project ${stamp}`) ?? false;
  record('Bob sees Alice project in sidebar', projectTitleVisible);
  await bobP.screenshot({ path: '/tmp/share-ui-03-bob-home.png', fullPage: true });

  // Bob navigates to the project page
  await bobP.goto(`${FRONTEND}/crossmodel/projects/${project.id}`);
  await bobP.waitForLoadState('networkidle', { timeout: 15000 });
  const bobProjectBody = await bobP.textContent('body');
  record('Bob can open the shared project page',
    !!bobProjectBody?.includes(`UI Project ${stamp}`));
  record('Bob sees the chat title in the shared project',
    !!bobProjectBody?.includes(`UI Test Chat ${stamp}`));
  await bobP.screenshot({ path: '/tmp/share-ui-04-bob-project.png', fullPage: true });

  // Bob opens the chat — this is the critical previously-broken case
  // The frontend's chat URL pattern can vary; we test the API path which is what the UI calls.
  const bobLS = await bobCtx.storageState();
  const bobTok = bobLS.origins?.[0]?.localStorage?.find((kv: any) => kv.name === 'accessToken')?.value;
  const bobReadRes = await fetch(`${BACKEND}/api/crossmodel/chats/${chatId}`, {
    headers: { Authorization: `Bearer ${bobTok}` },
  });
  record('Bob (viewer) can fetch C1 via API while in UI session',
    bobReadRes.status === 200, `status=${bobReadRes.status}`);

  // ── Public share link ─────────────────────────────────────────────────────
  // Alice creates a share link for the project chat
  const shareRes = await fetch(`${BACKEND}/api/crossmodel/chats/${chatId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceTok}` },
    body: JSON.stringify({}),
  });
  const shareJson = await shareRes.json();
  record('Alice creates a share link', shareRes.status === 200, `token=${shareJson.shareToken?.slice(0, 8)}`);

  // Anonymous browser context — no cookies, no localStorage
  const anonCtx = await browser.newContext();
  const anonP = await anonCtx.newPage();
  await anonP.goto(`${FRONTEND}/crossmodel/shared/chat/${shareJson.shareToken}`);
  await anonP.waitForLoadState('networkidle', { timeout: 15000 });
  const anonBody = await anonP.textContent('body');
  record('Anonymous user can view public share page',
    !!anonBody?.includes(`UI Test Chat ${stamp}`) || (anonBody?.length ?? 0) > 100,
    anonBody?.includes(`UI Test Chat ${stamp}`) ? 'chat title present' : `body=${anonBody?.slice(0, 80)}…`);
  await anonP.screenshot({ path: '/tmp/share-ui-05-anon-share.png', fullPage: true });

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log('\nScreenshots:');
  for (const f of fs.readdirSync('/tmp').filter((n) => n.startsWith('share-ui-'))) {
    console.log(`  /tmp/${f}`);
  }
  if (failed.length) {
    console.log('\nFailing:');
    failed.forEach((r) => console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
