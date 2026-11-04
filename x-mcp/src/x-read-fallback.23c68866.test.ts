/**
 * 23c68866 read-fallback tests (node:test via tsx — zero new deps).
 *
 * Ticket 23c68866 (2026-09-22): x_search / x_get_trends returned empty /
 * "No result" for a CONNECTED user. Root cause, live-reproduced twice that
 * day through the production gateway:
 *   - x.com's unauthenticated scrape began returning EMPTY bodies ("(Bright
 *     Data returned empty content …)") — invisible to the f609ec35 wall
 *     markers, so it was wrapped under a result header and served as
 *     pseudo-data ("# X search …\n\n(Bright Data returned empty content…)").
 *   - x_get_trends has no OAuth leg at all (X API v2 trends is
 *     enterprise-gated), so it was permanently broken for every user.
 * Fix legs covered here:
 *   1. scrapeFailureReason — empty/error gateway shapes are CLASSIFIED, never
 *      served as data;
 *   2. x_search — wall/empty scrape falls back to the gateway search_engine
 *      SERP (site:x.com); X operators are sanitized for Google;
 *   3. x_get_trends — wall/empty scrape falls back to the login-free
 *      trends24.in mirror (verbatim fixture from the live 2026-09-22 scrape);
 *   4. both still degrade HONESTLY when every leg fails, and pass real content
 *      through untouched.
 *
 * Run: npm test (tsx --test src/*.test.ts)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectXWall,
  scrapeFailureReason,
  parseSerpItems,
  serpQueryForXSearch,
  parseTrends24,
  search,
  getTrends,
  getUserProfile,
  getTweet,
} from './brightdata-client.js';

// ── 1. scrapeFailureReason ───────────────────────────────────────────────────

test('scrapeFailureReason classifies every gateway failure shape (23c68866)', () => {
  assert.match(
    scrapeFailureReason('(Bright Data returned empty content for https://x.com/explore/tabs/trending.)')!,
    /empty content/,
  );
  assert.ok(scrapeFailureReason('(Bright Data returned no parseable response for https://x.com/search?q=ai.)'));
  assert.ok(scrapeFailureReason('Bright Data error for https://x.com/search?q=ai: boom'));
  assert.ok(scrapeFailureReason('Error scraping https://x.com/search?q=ai via Bright Data: timeout'));
  assert.ok(scrapeFailureReason('Bright Data MCP token not configured (MCP_DIGBY_TOKEN) — cannot fetch X content.'));
});

test('scrapeFailureReason passes real content', () => {
  assert.equal(scrapeFailureReason('# X search — "ai"\n\n**@someone** posted: shipping agents today'), null);
  assert.equal(scrapeFailureReason('1. [Halo](https://twitter.com/search?q=Halo)'), null);
});

// ── 2. x_search SERP fallback ────────────────────────────────────────────────

const SERP_JSON = JSON.stringify({
  query: 'site:x.com AI agents',
  results_cnt: 12345,
  organic: [
    { title: 'OpenAI Newsroom (@OpenAINewsroom) on X', link: 'https://x.com/OpenAINewsroom', description: 'OpenAI is announcing new commitments for researchers…' },
    { title: 'Andy Jassy (@ajassy) on X', link: 'https://x.com/ajassy/status/2048806022253609115', description: 'Very interesting announcement from OpenAI this morning…' },
  ],
});

test('x_search: wall scrape falls back to the site:x.com SERP leg (23c68866 repro)', async () => {
  const out = await search('AI agents', {
    scrape: async () => '(Bright Data returned empty content for https://x.com/search?q=AI%20agents&f=live.)',
    serp: async () => SERP_JSON,
  });
  assert.match(out, /^# X search — "AI agents"/);
  assert.match(out, /via Google SERP \(site:x\.com AI agents\)/);
  assert.match(out, /OpenAI Newsroom/);
  assert.match(out, /https:\/\/x\.com\/ajassy\/status\/2048806022253609115/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_search: real scrape content passes through, SERP never consulted', async () => {
  let serpCalls = 0;
  // A REAL x.com search-results page is dense with X's own post links — the
  // round-3 structural gate requires them before the scrape is served.
  const dense = [
    '# search',
    '',
    '**@a** posted: real X post content. '.repeat(6),
    'https://x.com/a/status/2102577550874804631',
    'https://x.com/b/status/2102577565169041486',
    'https://x.com/c/status/2102577546432782365',
  ].join('\n');
  const out = await search('agents', {
    scrape: async () => dense,
    serp: async () => { serpCalls++; return SERP_JSON; },
  });
  assert.match(out, /^# X search — "agents"/);
  assert.match(out, /real X post content/);
  assert.equal(serpCalls, 0);
});

test('x_search: SERP leg empty/failed → honest degraded message, not pseudo-data', async () => {
  for (const serpOut of [
    '(Bright Data returned empty content for site:x.com ai.)',
    '{"organic":[]}',
  ]) {
    const out = await search('ai', {
      scrape: async () => 'Log in or sign up for X to see what is happening.',
      serp: async () => serpOut,
    });
    assert.match(out, /⚠ X READ DEGRADED/);
    assert.match(out, /NOT a user X-connection problem/);
  }
});

test('serpQueryForXSearch keeps meaning, drops Google-hostile X operators', () => {
  assert.equal(serpQueryForXSearch('AI agents'), 'site:x.com AI agents');
  assert.equal(serpQueryForXSearch('from:sama GPT-6'), 'site:x.com sama GPT-6');
  assert.equal(serpQueryForXSearch('lang:en since:2026-09-01 Opus 5.5 filter:links'), 'site:x.com Opus 5.5');
  // an operators-only query falls back to the raw query rather than a bare site:
  assert.equal(serpQueryForXSearch('since:2026-09-01'), 'site:x.com since:2026-09-01');
});

test('parseSerpItems handles the JSON shape and a markdown shape', () => {
  const fromJson = parseSerpItems(SERP_JSON);
  assert.equal(fromJson.length, 2);
  assert.equal(fromJson[0].link, 'https://x.com/OpenAINewsroom');
  const fromMd = parseSerpItems('- [Sam Altman on X](https://x.com/sama) — GPT-6 Astra is rolling out…');
  assert.equal(fromMd.length, 1);
  assert.equal(fromMd[0].snippet, 'GPT-6 Astra is rolling out…');
  assert.deepEqual(parseSerpItems('no results here'), []);
});

// ── 3. x_get_trends trends24.in mirror fallback ──────────────────────────────
//
// Verbatim-shape fixture from the live 2026-09-22 19:39Z scrape of
// https://trends24.in/united-states/ (the promo block before the H1 is real —
// the parser must skip it and take the FIRST ### timestamp block).
const TRENDS24_MD = [
  '  United States — X (Twitter) trending topics and hashtags today | trends24.in',
  '',
  '[new Historical trending data now available on **archive.trends24.in** →](https://archive.trends24.in)',
  '',
  '### Explore more apps',
  '',
  '*   [Trends24 Archive](https://archive.trends24.in)',
  '',
  '# United States X (Twitter) Trends for last 24 hours',
  '',
  'Timeline Tag Cloud Table',
  '',
  '## Twitter Trends Timeline for last 24 hours',
  '',
  '### Tue Sep 22 2026 19:39:47 GMT+0000 (Coordinated Universal Time)',
  '',
  '1.  [Halo](https://twitter.com/search?q=Halo)',
  '2.  [Opus 5.5](https://twitter.com/search?q=Opus%205.5)',
  '3.  [Patient Zero](https://twitter.com/search?q=Patient%20Zero)',
  '4.  [Activision](https://twitter.com/search?q=Activision)',
  '5.  [Case Keenum](https://twitter.com/search?q=Case%20Keenum)',
  '6.  [#ErdoganTheVoiceOfJustice](https://twitter.com/search?q=%23ErdoganTheVoiceOfJustice)',
  '',
  '### Tue Sep 22 2026 18:45:50 GMT+0000 (Coordinated Universal Time)',
  '',
  '1.  [Halo](https://twitter.com/search?q=Halo)',
  '2.  [Opus 5.5](https://twitter.com/search?q=Opus%205.5)',
  '3.  [Activision](https://twitter.com/search?q=Activision)',
  '4.  [Patient Zero](https://twitter.com/search?q=Patient%20Zero)',
  '5.  [Case Keenum](https://twitter.com/search?q=Case%20Keenum)',
  '6.  [taylor swift](https://twitter.com/search?q=taylor%20swift)',
].join('\n');

test('parseTrends24 extracts the FIRST hourly block and skips the promo (23c68866 fixture)', () => {
  const snap = parseTrends24(TRENDS24_MD)!;
  assert.ok(snap, 'fixture must parse');
  assert.equal(snap.region, 'United States');
  assert.match(snap.timestamp, /Tue Sep 22 2026 19:39:47/);
  assert.equal(snap.items.length, 6);
  assert.equal(snap.items[0].name, 'Halo');
  assert.equal(snap.items[1].name, 'Opus 5.5');
  assert.equal(snap.items[5].name, '#ErdoganTheVoiceOfJustice');
});

test('parseTrends24 rejects pages without a usable snapshot', () => {
  assert.equal(parseTrends24('no trends here at all'), null);
  assert.equal(parseTrends24('### Tue Sep 22 2026 19:39:47 GMT+0000 (Coordinated Universal Time)\n\n1.  [Only](https://twitter.com/search?q=Only)'), null);
});

// Round-2 live repro (2026-09-23 00:00Z, box-A container diag): the SAME
// https://trends24.in/ URL, fetched through the container's own JSON-RPC
// tools/call to mcp.digby.example.com, arrives with heading markers and list numbering
// STRIPPED — bare date lines, bare '[name](url)' items, blank lines between
// them, promo block intact. (The platform-side scrape_as_markdown tool
// returns the RICH TRENDS24_MD shape above.) parseTrends24 accepted only the
// rich shape, so the mirror leg silently returned null in production while
// these tests stayed green. Both shapes must parse.
const TRENDS24_MD_STRIPPED = [
  'Worldwide — X (Twitter) trending topics and hashtags today | trends24.in',
  '',
  '[new Historical trending data now available on archive.trends24.in →](https://archive.trends24.in)',
  '',
  '[trends24](/) Worldwide',
  '',
  'close',
  '',
  '[X (Twitter)](https://twitter.com/_trends24)',
  '',
  'Launching Trends24 Archive Subscription',
  '',
  'Worldwide X (Twitter) Trends for last 24 hours',
  '',
  'Timeline Tag Cloud Table',
  '',
  'Twitter Trends Timeline for last 24 hours',
  '',
  'Wed Sep 23 2026 00:00:18 GMT+0000 (Coordinated Universal Time)',
  '',
  '[カウコン](https://twitter.com/search?q=%E3%82%AB%E3%82%A6%E3%82%B3%E3%83%B3)',
  '',
  '[#اليوم\\_الوطني\\_السعودي\\_٩٦](https://twitter.com/search?q=%23%D8%A7%D9%84%D9%8A%D9%88%D9%85)',
  '',
  '[連休最終日](https://twitter.com/search?q=%E9%80%A3%E4%BC%91%E6%9C%80%E7%B5%82%E6%97%A5)',
  '',
  '[Opus 5.5](https://twitter.com/search?q=Opus%205.5)',
  '',
  '[Taylor](https://twitter.com/search?q=Taylor)',
  '',
  '[Patient Zero](https://twitter.com/search?q=Patient%20Zero)',
  '',
  'Tue Sep 22 2026 22:12:38 GMT+0000 (Coordinated Universal Time)',
  '',
  '[カウコン](https://twitter.com/search?q=%E3%82%AB%E3%82%A6%E3%82%B3%E3%83%B3)',
].join('\n');

test('parseTrends24 accepts the gateway-stripped shape (23c68866 round-2 live repro)', () => {
  const snap = parseTrends24(TRENDS24_MD_STRIPPED)!;
  assert.ok(snap, 'stripped fixture must parse');
  assert.equal(snap.region, 'Worldwide');
  assert.match(snap.timestamp, /Wed Sep 23 2026 00:00:18/);
  assert.equal(snap.items.length, 6);
  assert.equal(snap.items[0].name, 'カウコン');
  assert.equal(snap.items[1].name, '#اليوم_الوطني_السعودي_٩٦'); // markdown \\_ unescaped
  assert.equal(snap.items[3].name, 'Opus 5.5');
  // promo/nav links (trends24.in, twitter.com/_trends24) are never collected as trends
  assert.ok(snap.items.every((it) => it.url.startsWith('https://twitter.com/search?q=')));
  // region capture is real, not the 'Worldwide' default (reviewer finding 4:
  // the fixture's own region IS Worldwide, so assert on a swapped variant)
  const usVariant = TRENDS24_MD_STRIPPED.replace(
    'Worldwide X (Twitter) Trends for last 24 hours',
    'United States X (Twitter) Trends for last 24 hours',
  );
  assert.equal(parseTrends24(usVariant)!.region, 'United States');
});

test('x_get_trends: stripped mirror still yields the real trends list, not DEGRADED (23c68866 round 2)', async () => {
  const out = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com')
      ? 'Continue with phone\nContinue with Google' // the wall
      : TRENDS24_MD_STRIPPED,
  });
  assert.match(out, /^# X trends — Worldwide/);
  assert.match(out, /via the trends24\.in mirror/);
  assert.match(out, /Snapshot: Wed Sep 23 2026 00:00:18/);
  assert.match(out, /\[Opus 5\.5\]/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_get_trends: the trends24 mirror is tried FIRST — the always-walled x.com leg is no longer first-word latency (11d98377)', async () => {
  const calls: string[] = [];
  const wall = 'X - The Everything App\n\nContinue with phone\nContinue with Google\n\nPrivacy Policy · Terms of Service';
  const out = await getTrends(undefined, {
    scrape: async (url) => { calls.push(url); return url.includes('x.com') ? wall : TRENDS24_MD; },
  });
  // Mirror-first (11d98377): the mirror answers and the x.com leg — wall/empty in every
  // observation since 23c68866, and a 25–40 s toll when it ran first on the controller's
  // blocking prefetch — is never scraped at all.
  assert.deepEqual(calls, ['https://trends24.in/']);
  assert.match(out, /^# X trends — United States/);
  assert.match(out, /via the trends24\.in mirror/);
  assert.match(out, /Snapshot: Tue Sep 22 2026 19:39:47/);
  assert.match(out, /1\. \[Halo\]/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_get_trends: empty-body scrape also routes to the mirror (the 23c68866 empty case)', async () => {
  const out = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com')
      ? '(Bright Data returned empty content for https://x.com/explore/tabs/trending.)'
      : TRENDS24_MD,
  });
  assert.match(out, /via the trends24\.in mirror/);
  assert.match(out, /Opus 5\.5/);
});

test('x_get_trends: verified WOEID maps to the mirror region; unknown WOEID notes worldwide', async () => {
  const us = await getTrends('23424977', { scrape: async (url) => url.includes('x.com') ? 'Log in or sign up for X.' : TRENDS24_MD });
  assert.match(us, /# X trends — United States/);
  assert.doesNotMatch(us, /no verified mirror region/);

  const unknown = await getTrends('99999999', { scrape: async (url) => url.includes('x.com') ? 'Log in or sign up for X.' : TRENDS24_MD });
  assert.match(unknown, /requested WOEID 99999999 has no verified mirror region/);
});

test('x_get_trends: mirror also failing → honest degraded message', async () => {
  const out = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com')
      ? 'Continue with Google Continue with Apple'
      : '(Bright Data returned empty content for https://trends24.in/.)',
  });
  assert.match(out, /⚠ X READ DEGRADED/);
  assert.match(out, /NOT a user X-connection problem/);
});

test('x_get_trends: real x.com scrape content passes through when the mirror is down (the mirror-first fallback, 11d98377)', async () => {
  const urls: string[] = [];
  // A REAL x.com trending page is dense with X's own trend search links — the
  // round-3 structural gate requires them before the scrape is served. Under
  // mirror-first (11d98377) the x.com leg runs only when the mirror itself
  // failed (outage / parse drift), so this shape pins: mirror tried first,
  // x.com fallback served, same output format as before.
  const dense = [
    '# Explore',
    '',
    ...Array.from({ length: 5 }, (_, i) => `Trending: [topic ${i + 1}](https://x.com/search?q=${encodeURIComponent(`topic ${i + 1}`)}) — ${'agents everywhere. '.repeat(8)}`),
  ].join('\n');
  const out = await getTrends(undefined, {
    scrape: async (url) => { urls.push(url); return url.includes('trends24.in') ? '(Bright Data returned empty content for https://trends24.in/.)' : dense; },
  });
  assert.match(out, /^# X trends\n/);
  assert.deepEqual(urls, ['https://trends24.in/', 'https://x.com/explore/tabs/trending']);
});

// ── 4b. round-3: localized walls + structural gates (23c68866 round 3) ──────
//
// Observed live 2026-09-23 01:43Z: Bright Data's exit node was es-locale, and
// x.com served its login wall IN SPANISH ("X. Es lo que está pasando /
// Continuar con el teléfono / Continuar con Google / Continuar con Apple /
// Correo electrónico o nombre de usuario / Al continuar, aceptas nuestros
// Términos…"). Every WALL_MARKERS regex was English-only, so detectXWall
// missed it and getTrends served the raw wall under the "# X trends" header —
// the ticket's original pseudo-data bug, locale-variant. The round-3 fix has
// two layers: observed-es markers, AND structural gates that serve the x.com
// scrape only when it carries the link density of a real page — so a wall in
// ANY unobserved locale can no longer be served as data.

const X_WALL_ES = [
  '# X trends',
  '',
  'X. Es lo que está pasando',
  '',
  'Lo que está pasando ahora.',
  '',
  'Continuar con el teléfono',
  '',
  'Continuar con Google',
  '',
  'Continuar con Apple',
  '',
  'Correo electrónico o nombre de usuario',
  '',
  'Al continuar, aceptas nuestros [Términos de servicio](https://x.com/tos) y [Política de privacidad](https://x.com/privacy).',
  '',
  '[Información](https://about.x.com) · [Ayuda](https://help.x.com) · [Empleos](https://careers.x.com)',
].join('\n');

// A wall in a locale NO marker covers (Japanese here) — the STRUCTURAL gate
// is the only thing standing between this wall and the caller. (fr/de/pt/it
// gained SSO markers in the reviewer-follow-up; using them here would make
// this test vacuous — it must exercise the marker-FREE path.)
const X_WALL_JA = [
  '# X trends',
  '',
  'X．いま起きていること',
  '',
  '電話番号で続ける · Googleで続ける · Appleで続ける',
  '',
  '続行すると、利用規約とプライバシーポリシーに同意したことになります。',
  '',
  ...Array.from({ length: 40 }, (_, i) => `日本語の充填行 ${i} — 長さのヒューリスティックを打ち負かすのに十分な密度ですが、これは依然としてログイン壁です`),
].join('\n');

test('detectXWall: the observed es-locale login wall is detected (23c68866 round 3)', () => {
  assert.match(detectXWall(X_WALL_ES)!, /login wall/);
});

test('detectXWall: fr/de/pt/it SSO rows are detected (23c68866 round 3, reviewer finding 1)', () => {
  assert.match(detectXWall('Continuer avec Google')!, /login wall/);
  assert.match(detectXWall('Continuer avec le téléphone')!, /login wall/);
  assert.match(detectXWall('Fortfahren mit Google')!, /login wall/);
  assert.match(detectXWall('Mit Apple fortfahren')!, /login wall/);
  assert.match(detectXWall('Continuar com o Google')!, /login wall/);
  assert.match(detectXWall('Continua con Apple')!, /login wall/);
});

test('x_get_trends: es-locale wall routes to the trends24 mirror, never served as data (23c68866 round 3)', async () => {
  const out = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com') ? X_WALL_ES : TRENDS24_MD_STRIPPED,
  });
  assert.match(out, /^# X trends — Worldwide/);
  assert.match(out, /via the trends24\.in mirror/);
  assert.doesNotMatch(out, /Continuar con/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_get_trends: an UNRECOGNIZED-locale wall cannot be served as data — the mirror-first path never scrapes it (23c68866 round 3 + 11d98377)', async () => {
  const calls: string[] = [];
  const out = await getTrends(undefined, {
    scrape: async (url) => { calls.push(url); return url.includes('x.com') ? X_WALL_JA : TRENDS24_MD; },
  });
  // Mirror-first (11d98377): the mirror answers first; the x.com wall (any locale)
  // is never fetched at all — it survives only as the fallback leg.
  assert.deepEqual(calls, ['https://trends24.in/']);
  assert.match(out, /via the trends24\.in mirror/);
  assert.match(out, /Snapshot: Tue Sep 22 2026 19:39:47/);
  assert.doesNotMatch(out, /いま起きていること/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_search: an UNRECOGNIZED-locale wall cannot be served as data — the structural gate routes to the SERP leg (23c68866 round 3)', async () => {
  const out = await search('AI agents', {
    scrape: async () => X_WALL_JA,
    serp: async () => SERP_JSON,
  });
  assert.match(out, /via Google SERP/);
  assert.match(out, /OpenAI Newsroom/);
  assert.doesNotMatch(out, /いま起きていること/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('gate boundaries: below-threshold link counts route to the fallback legs (23c68866 round 3)', async () => {
  // A trends page with exactly TWO search links — below the >=3 gate — must
  // not be served as x.com data; it routes to the mirror.
  const twoLinks = [
    '# Explore',
    '',
    '[a](https://x.com/search?q=a) [b](https://x.com/search?q=b)',
    '',
    ...Array.from({ length: 20 }, (_, i) => `trending-ish filler line ${i}`),
  ].join('\n');
  const outT = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com') ? twoLinks : TRENDS24_MD,
  });
  assert.match(outT, /via the trends24\.in mirror/);
  assert.doesNotMatch(outT, /trending-ish filler/);

  // A search page with exactly ONE post link — below the >=2 gate — routes
  // to the SERP leg.
  const onePost = [
    '# search',
    '',
    'one lonely post: https://x.com/a/status/2102577550874804631',
    '',
    ...Array.from({ length: 20 }, (_, i) => `search-ish filler line ${i}`),
  ].join('\n');
  const outS = await search('ai', {
    scrape: async () => onePost,
    serp: async () => SERP_JSON,
  });
  assert.match(outS, /via Google SERP/);
  assert.doesNotMatch(outS, /search-ish filler/);
});

test('x_get_trends: gate-fail + mirror-fail names the unrecognized shape honestly (23c68866 round 3)', async () => {
  // Marker-FREE wall (no locale marker matches X_WALL_JA) + a dead mirror:
  // the degraded banner must carry the structural gate's reason, not a wall
  // classification — pinning the honest-reason string itself.
  const out = await getTrends(undefined, {
    scrape: async (url) => url.includes('x.com')
      ? X_WALL_JA
      : '(Bright Data returned empty content for https://trends24.in/.)',
  });
  assert.match(out, /⚠ X READ DEGRADED/);
  assert.match(out, /NOT a user X-connection problem/);
  assert.match(out, /unrecognized page \(no trends list found/);
});

test('x_search: gate-fail + SERP-fail names the unrecognized shape honestly (23c68866 round 3)', async () => {
  const out = await search('ai', {
    scrape: async () => X_WALL_JA,
    serp: async () => '{"organic":[]}',
  });
  assert.match(out, /⚠ X READ DEGRADED/);
  assert.match(out, /unrecognized page \(no X post links found/);
});


//
// Reviewer MAJOR on f42bfa8c (2026-09-22): the 23c68866 empty-body class also
// reaches x_get_user_profile / x_get_tweet — they ran wall detection only, so
// an empty gateway body was still wrapped under a header and served as
// pseudo-data. There is no mirror for profiles/tweets; the fix is the honest
// degraded message via scrapeFailureReason, never pseudo-data.

test('x_get_user_profile: empty-body scrape degrades honestly, never pseudo-data (23c68866 class)', async () => {
  const out = await getUserProfile('LangChainAI', {
    scrape: async () => '(Bright Data returned empty content for https://x.com/LangChainAI.)',
  });
  assert.match(out, /⚠ X READ DEGRADED/);
  assert.match(out, /the @LangChainAI profile/);
  assert.match(out, /empty content/);
  assert.match(out, /NOT a user X-connection problem/);
  assert.doesNotMatch(out, /# @LangChainAI — profile \+ recent posts/);
});

test('x_get_user_profile: real scrape content passes through', async () => {
  const dense = `# @LangChainAI\n\n${'Building the agent framework. '.repeat(20)}`;
  const out = await getUserProfile('LangChainAI', { scrape: async () => dense });
  assert.match(out, /^# @LangChainAI — profile \+ recent posts/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});

test('x_get_tweet: empty-body and gateway-error scrapes degrade honestly (23c68866 class)', async () => {
  for (const scrapeOut of [
    '(Bright Data returned empty content for https://x.com/sama/status/123.)',
    'Error scraping https://x.com/sama/status/123 via Bright Data: timeout',
  ]) {
    const out = await getTweet('https://x.com/sama/status/123', { scrape: async () => scrapeOut });
    assert.match(out, /⚠ X READ DEGRADED/);
    assert.match(out, /NOT a user X-connection problem/);
    assert.doesNotMatch(out, /# Tweet/);
  }
});

test('x_get_tweet: real scrape content passes through', async () => {
  const dense = `# tweet\n\n${'Shipping GPT-6 Astra today. '.repeat(20)}`;
  const out = await getTweet('sama/status/123', { scrape: async () => dense });
  assert.match(out, /^# Tweet https:\/\/x\.com\/sama\/status\/123/);
  assert.doesNotMatch(out, /X READ DEGRADED/);
});
