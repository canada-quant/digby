/**
 * Read X.com content via Bright Data tools, proxied through the mcp.digby.ai
 * gateway. This is the FALLBACK read path — when the caller's per-user OAuth
 * token is attached, server.ts prefers the authenticated X API v2 reads in
 * x-client.ts (ticket f609ec35, 2026-09-22).
 *
 * X's anti-bot serves a LOGIN WALL (or a 404 wall, or EMPTY content) to
 * unauthenticated scrapers on profile/search/explore pages. Wall pages and
 * empty payloads must never be served to callers as if they were data:
 *   1. every scrape runs detectXWall() on the markdown;
 *   2. every scrape runs scrapeFailureReason() for the empty/error shapes
 *      (ticket 23c68866 — X began returning EMPTY bodies, which wall markers
 *      cannot catch, and they were served as pseudo-data → "No result");
 *   3. search and trends have working fallback legs (ticket 23c68866):
 *      x_search  → gateway `search_engine` SERP with site:x.com (Google-indexed
 *                  X posts — validated live 2026-09-22 while x.com itself was
 *                  unscrapable);
 *      x_get_trends → the login-free trends24.in mirror (X API v2 trends is
 *                  enterprise-gated; x.com/explore is wall/empty for scrapers).
 */

import axios from 'axios';

// Bright Data MCP gateway lives at /mcp on mcp.digby.ai. The tools are named
// `scrape_as_markdown` / `search_engine` on the gateway (the `brightdata_`
// prefix is from a different MCP namespace and doesn't exist on this server).
const BRIGHTDATA_MCP_URL = process.env.BRIGHTDATA_MCP_URL || 'https://mcp.digby.ai/mcp';
const TOKEN = process.env.MCP_DIGBY_TOKEN || '';

let nextRequestId = 1;

// ── X anti-bot wall detection (ticket f609ec35) ─────────────────────────────
//
// Reproduced live 2026-09-22: x_get_user_profile("LangChainAI") returned X's
// logged-out page ("User Profile Not Found - X | 404 Error … Log in or sign up
// for X / Continue with phone / Continue with Google") AS IF IT WERE DATA, and
// research lanes injected that wall markdown into model context as "X data".
// The markers below cover the wall variants we have observed; the short-shell
// heuristic catches the stripped nav/footer-only page.

const WALL_MARKERS: Array<{ re: RegExp; why: string }> = [
  { re: /log in or sign up/i,                                   why: 'login wall ("Log in or sign up")' },
  { re: /continue with (google|apple|phone)/i,                  why: 'login wall (SSO buttons)' },
  // X localizes its wall per exit node (ticket 23c68866 round 3, observed
  // live 2026-09-23 01:43Z): an es-locale wall served "Continuar con el
  // teléfono / Continuar con Google / Continuar con Apple / Correo
  // electrónico o nombre de usuario" and matched NO English marker — it was
  // served under the result header as pseudo-data. Markers cover OBSERVED
  // locales only; the structural gates in search() and getTrends() are what
  // make those two reads locale-immune.
  { re: /continuar con (google|apple|el teléfono|tel[eé]fono)/i, why: 'login wall (SSO buttons, es)' },
  { re: /correo electr[oó]nico o nombre de usuario/i,            why: 'login wall (login form, es)' },
  // The same SSO row in the other high-traffic locales (round-3 reviewer
  // finding 1): getUserProfile/getTweet have NO fallback leg, so a marker
  // miss there serves pseudo-data. German matches both word orders.
  // No structural gate for those two reads: with no observed real-page
  // fixture, a link-density gate risks degrading genuine reads — the
  // locale-immune gates live in search()/getTrends(), which have fallback
  // legs that serve real data either way.
  { re: /continuer avec (?:le )?(?:google|apple|t[eé]l[eé]phone)/i, why: 'login wall (SSO buttons, fr)' },
  { re: /fortfahren mit (?:google|apple|telefon)|mit (?:google|apple|telefon) fortfahren/i, why: 'login wall (SSO buttons, de)' },
  { re: /continuar com (?:o )?(?:google|apple|telefone)/i,          why: 'login wall (SSO buttons, pt)' },
  { re: /continua con (?:il )?(?:google|apple|telefono)/i,          why: 'login wall (SSO buttons, it)' },
  { re: /sign up for x\b/i,                                     why: 'signup wall' },
  { re: /don.t miss what.s happening/i,                         why: 'login wall (marketing banner)' },
  { re: /user profile not found/i,                              why: 'profile 404 wall' },
  { re: /something went wrong[\s\S]{0,80}try reloading/i,       why: 'X error wall' },
  { re: /this account doesn.t exist/i,                          why: 'account-not-found wall' },
  { re: /log in to x\b/i,                                       why: 'login wall' },
];

/**
 * Returns a human-readable wall reason when the scraped markdown is X's
 * login/404/error wall rather than real page data; null when it looks like
 * genuine content. Exported for tests.
 */
export function detectXWall(md: string): string | null {
  for (const m of WALL_MARKERS) {
    if (m.re.test(md)) return m.why;
  }
  // A real X page is content-dense; a stripped wall shell is short and
  // footer-heavy (nav links + legal footer, almost no content).
  if (md.length < 400 && /privacy policy/i.test(md) && /terms of service/i.test(md)) {
    return 'bare nav/footer shell (login-wall variant)';
  }
  return null;
}

// ── Gateway failure classification (ticket 23c68866) ────────────────────────
//
// The sentinel strings are module constants so the classifier can never drift
// from the emitter. Wall detection needs page TEXT; X's newer anti-bot also
// returns EMPTY bodies (observed live 2026-09-22 on /explore and /search),
// which no marker can catch — this classifier is what routes those reads to
// the fallback legs instead of serving them as data.

const FAIL_TOKEN_MISSING =
  'Bright Data MCP token not configured (MCP_DIGBY_TOKEN) — cannot fetch X content.';
const failNoPayload = (url: string) => `(Bright Data returned no parseable response for ${url}.)`;
const failGatewayError = (url: string, msg: string) => `Bright Data error for ${url}: ${msg}`;
const failEmpty = (url: string) => `(Bright Data returned empty content for ${url}.)`;
const failTransport = (url: string, msg: string) => `Error scraping ${url} via Bright Data: ${msg}`;

/**
 * Returns a short reason when the gateway response string is one of OUR known
 * failure shapes (empty content, unparseable payload, gateway error, transport
 * error, missing token); null when it looks like real content. Exported for
 * tests.
 */
export function scrapeFailureReason(text: string): string | null {
  if (text.startsWith(FAIL_TOKEN_MISSING.slice(0, 40))) return 'gateway token not configured';
  if (text.startsWith('(Bright Data returned no parseable response')) return 'no parseable response from the gateway';
  if (text.startsWith('Bright Data error for ')) return 'gateway error';
  if (text.startsWith('(Bright Data returned empty content')) return 'empty content (X anti-bot served nothing)';
  if (text.startsWith('Error scraping ')) return 'scrape transport error';
  return null;
}

// ── Structural content gates (ticket 23c68866 round 3) ──────────────────────
//
// X localizes its login wall per exit node: observed live 2026-09-23 01:43Z,
// an es-locale wall ("Continuar con el teléfono / Continuar con Google /
// Continuar con Apple / Correo electrónico o nombre de usuario") matched NO
// English WALL_MARKERS and was served under the "# X trends" header as
// pseudo-data. Markers only cover locales we have OBSERVED; these gates make
// x_search and x_get_trends locale-immune by construction: a real explore /
// search-results page is dense with X's own deep links, and no wall variant
// in ANY locale carries them. Both gates fail SAFE — when the gate rejects a
// scrape, the fallback leg (SERP / trends24 mirror) serves the same real
// data, so a false positive only changes which leg produced it.

const X_SEARCH_LINK_RE = /https?:\/\/(?:[a-z]+\.)?(?:twitter\.com|x\.com)\/search\?q=/g;
const X_POST_LINK_RE = /https?:\/\/(?:[a-z]+\.)?(?:twitter\.com|x\.com)\/[^/\s"')]+\/status\/\d+/g;

/** X search links in the markdown — a real trending page has many (round-3 gate). */
export function countXSearchLinks(md: string): number {
  return (md.match(X_SEARCH_LINK_RE) ?? []).length;
}

/** X post links in the markdown — a real search-results page has many (round-3 gate). */
export function countXPostLinks(md: string): number {
  return (md.match(X_POST_LINK_RE) ?? []).length;
}

/**
 * The honest degraded-read message. It must be impossible for a downstream
 * model to misread this as a user-connection problem — reads scrape PUBLIC
 * data and never used the user's X account (ticket f609ec35: the legacy
 * "integration may not be connected" misattribution sent connected users to
 * Settings → Integrations for a platform-side failure).
 */
function degradedRead(what: string, why: string): string {
  return [
    `⚠ X READ DEGRADED — could not fetch ${what}: x.com served its ${why} to the unauthenticated scrape path (X anti-bot blocks public scraping of this surface).`,
    `This is a platform-side read failure, NOT a user X-connection problem — X reads use public data and never required the user's X account. Do NOT tell the user to connect or reconnect X.`,
    `Workaround: web search with site:x.com queries (indexed X post content), or retry later.`,
  ].join('\n');
}

/** Call any tool on the Bright Data MCP gateway; failure shapes are the module sentinels. */
async function callGatewayTool(name: string, args: Record<string, unknown>, label: string): Promise<string> {
  if (!TOKEN) {
    return FAIL_TOKEN_MISSING;
  }

  try {
    const response = await axios.post(
      BRIGHTDATA_MCP_URL,
      {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      },
      {
        headers: {
          'X-API-Key': TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        // x.com scrapes can take 25–40s through Bright Data's web-unlocker.
        // Allow up to 75s to avoid spurious timeouts on slow pages.
        timeout: 75000,
        responseType: 'text',
        transformResponse: (r) => r,
        validateStatus: (s) => s < 500,
      },
    );

    // Bright Data MCP returns either JSON or SSE. Handle both.
    const body = response.data as string;
    const jsonPayload = body.startsWith('{')
      ? body
      : (body.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== '[DONE]')
            .at(-1)) || '';

    if (!jsonPayload) {
      return failNoPayload(label);
    }

    const parsed = JSON.parse(jsonPayload);
    if (parsed.error) {
      return failGatewayError(label, parsed.error.message || JSON.stringify(parsed.error));
    }
    const text = parsed.result?.content?.[0]?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return failEmpty(label);
    }
    return text;
  } catch (err: any) {
    return failTransport(label, err.message);
  }
}

async function callScrapeAsMarkdown(url: string): Promise<string> {
  return callGatewayTool('scrape_as_markdown', { url }, url);
}

function trimMarkdown(md: string, limit = 8000): string {
  if (md.length <= limit) return md;
  return md.slice(0, limit) + `\n\n[…truncated ${md.length - limit} chars]`;
}

// ── Read tools (scrape fallback — wall-detected) ────────────────────────────

/** Injectable seam (tests) for the single-scrape read tools. */
export interface ScrapeDeps {
  scrape?: (url: string) => Promise<string>;
}

export async function getUserProfile(usernameRaw: string, deps: ScrapeDeps = {}): Promise<string> {
  const username = usernameRaw.replace(/^@/, '').trim();
  if (!username) return 'Empty username.';
  const scrape = deps.scrape ?? callScrapeAsMarkdown;
  const md = await scrape(`https://x.com/${encodeURIComponent(username)}`);
  const wall = detectXWall(md);
  const failed = scrapeFailureReason(md);
  if (wall || failed) return degradedRead(`the @${username} profile`, wall ?? `an unusable response (${failed})`);
  return `# @${username} — profile + recent posts\n\n${trimMarkdown(md)}`;
}

export async function getTweet(input: string, deps: ScrapeDeps = {}): Promise<string> {
  // Accept either a full URL or a "username/status/id" or just a numeric ID.
  let url: string;
  if (input.startsWith('http')) {
    url = input.replace('twitter.com', 'x.com');
  } else if (input.includes('/status/')) {
    url = `https://x.com/${input}`;
  } else if (/^\d+$/.test(input)) {
    url = `https://x.com/i/web/status/${input}`;
  } else {
    return `Unrecognized tweet identifier: ${input}. Pass a URL, "user/status/id", or numeric ID.`;
  }
  const scrape = deps.scrape ?? callScrapeAsMarkdown;
  const md = await scrape(url);
  const wall = detectXWall(md);
  const failed = scrapeFailureReason(md);
  if (wall || failed) return degradedRead(`the tweet ${url}`, wall ?? `an unusable response (${failed})`);
  return `# Tweet ${url}\n\n${trimMarkdown(md)}`;
}

// ── x_search: SERP fallback leg (ticket 23c68866) ───────────────────────────

export interface SerpItem { title: string; link: string; snippet: string }

/**
 * Parse Bright Data `search_engine` output into items. The gateway returns the
 * SERP as a JSON text blob ({ organic: [...] }); tolerate a markdown shape too.
 * Exported for tests.
 */
export function parseSerpItems(raw: string): SerpItem[] {
  // JSON shape (the common one — mcp-search.ts unwraps the same JSON text).
  try {
    const parsed = JSON.parse(raw);
    const organic = parsed?.organic;
    if (Array.isArray(organic)) {
      return organic
        .filter((r) => r && (r.title || r.description))
        .map((r) => ({
          title: String(r.title ?? '').trim(),
          link: String(r.link ?? r.url ?? '').trim(),
          snippet: String(r.description ?? r.snippet ?? '').trim(),
        }))
        .filter((r) => r.title || r.snippet);
    }
  } catch { /* not JSON — try markdown */ }

  // Markdown-ish fallback: "- [title](url) — snippet" or "[title](url)\nsnippet".
  const items: SerpItem[] = [];
  const re = /\[([^\]]{3,200})\]\((https?:\/\/[^)\s]+)\)([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    items.push({ title: m[1].trim(), link: m[2].trim(), snippet: m[3].replace(/^[\s—–-]+/, '').trim() });
  }
  return items;
}

/**
 * Map an X search query onto a Google site:x.com query. X-native operators
 * (from:/since:/lang:/filter:…) are Google-inert or Google-hostile: keep the
 * human-meaningful operands (from:sama → sama), drop the rest. Exported for
 * tests.
 */
export function serpQueryForXSearch(query: string): string {
  const kept: string[] = [];
  for (const tok of query.split(/\s+/)) {
    if (!tok) continue;
    const from = /^(from|to):@?(.+)$/i.exec(tok);
    if (from) { kept.push(from[2]); continue; }
    if (/^-?(since|until|lang|filter|near|within|min_retweets|min_replies|min_faves):/i.test(tok)) continue;
    if (/^-?from:/i.test(tok)) continue; // excluded author — no clean Google mapping
    kept.push(tok);
  }
  const core = kept.join(' ').trim();
  return `site:x.com ${core || query}`.trim();
}

/** Injectable seams (tests) — default to the real gateway calls. */
export interface SearchDeps {
  scrape?: (url: string) => Promise<string>;
  serp?: (query: string) => Promise<string>;
}

async function searchViaSerp(query: string, serp: (q: string) => Promise<string>): Promise<string | null> {
  const serpQuery = serpQueryForXSearch(query);
  const raw = await serp(serpQuery);
  if (scrapeFailureReason(raw)) return null;
  const items = parseSerpItems(raw);
  if (items.length === 0) return null;
  const lines = items.slice(0, 15).map((it, i) => {
    const bits = [`${i + 1}. **${it.title}**`];
    if (it.snippet) bits.push(`   ${it.snippet}`);
    if (it.link) bits.push(`   ${it.link}`);
    return bits.join('\n');
  });
  return [
    `# X search — "${query}"`,
    '',
    `_via Google SERP (${serpQuery}) — the direct x.com scrape is blocked by X anti-bot. ` +
      `These are Google-indexed X posts/profiles (recency varies; some links may be Google redirect wrappers)._`,
    '',
    ...lines,
  ].join('\n');
}

export async function search(query: string, deps: SearchDeps = {}): Promise<string> {
  if (!query.trim()) return 'Empty search query.';
  const scrape = deps.scrape ?? callScrapeAsMarkdown;
  const serp = deps.serp ?? (async (q: string) => callGatewayTool('search_engine', { query: q, engine: 'google' }, q));

  const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
  const md = await scrape(url);
  const wall = detectXWall(md);
  const failed = scrapeFailureReason(md);
  // Structural gate (round 3): serve the x.com scrape only when it carries
  // the post links a real results page has. X localizes its login wall per
  // exit node, so an unobserved-locale wall can evade every marker — but no
  // wall variant carries /status/ post links. Failing the gate routes to the
  // SERP leg, which serves real indexed X posts either way (safe direction);
  // a genuinely empty x.com results page also lands on the SERP leg, which is
  // strictly better than serving an unverifiable page.
  if (!wall && !failed && countXPostLinks(md) >= 2) {
    return `# X search — "${query}"\n\n${trimMarkdown(md, 12000)}`;
  }
  // x.com scrape defeated (login wall / empty body / unrecognized shape) — try
  // the SERP leg before admitting degradation (ticket 23c68866: this read was
  // permanently empty).
  const viaSerp = await searchViaSerp(query, serp);
  if (viaSerp) return viaSerp;
  return degradedRead(
    `search results for "${query}"`,
    wall ?? (failed
      ? `an unusable response (${failed})`
      : 'unrecognized page (no X post links found — possibly a login wall in an unobserved locale; X localizes its wall per exit node)'),
  );
}

// ── x_get_trends: trends24.in mirror leg (ticket 23c68866) ──────────────────
//
// X API v2 has no free-tier trends endpoint (GET /2/trends/by/woeid is
// enterprise-gated), so trends can NEVER take the OAuth path — and x.com's
// /explore scrape is wall/empty for unauthenticated fetchers. trends24.in is a
// login-free mirror of X's own trending list (validated live 2026-09-22 via
// the same Bright Data gateway: full hourly blocks of 50 trends).

/** WOEID → trends24.in region slug. Only mappings verified against the mirror. */
const WOEID_TO_TRENDS24_SLUG: Record<string, string> = {
  '1': '',                 // worldwide → trends24 root
  '23424977': 'united-states',
  '23424975': 'united-kingdom',
};

export interface Trends24Snapshot { region: string; timestamp: string; items: Array<{ name: string; url: string }> }

/**
 * Parse a trends24.in scrape (markdown) into the latest hourly snapshot.
 * The same URL arrives in TWO shapes (both observed live 2026-09-22, ticket
 * 23c68866 round 2): the platform-side scrape_as_markdown tool returns the
 * RICH shape ('### <date>' headers, '1.'-numbered items), while x-mcp's own
 * JSON-RPC tools/call through mcp.digby.ai returns the same page with the
 * heading markers and list numbering STRIPPED (bare '<date>' line, bare
 * '[name](url)' items). A parser that accepts only one shape makes the
 * mirror leg silently fail on the other path.
 * Returns null when no usable snapshot is found (<5 items — partial parses
 * would be served as a trends list and mislead). Exported for tests.
 */
export function parseTrends24(md: string): Trends24Snapshot | null {
  // Region line: '# United States X (Twitter) Trends for last 24 hours' (rich)
  // or the same line without the '#' (gateway-stripped). The page <title> says
  // 'trending topics', so it cannot collide with this phrase.
  const region = /^#{0,6}[ \t]*(.+?)[ \t]+X \(Twitter\) Trends for last 24 hours/m.exec(md)?.[1]?.trim() || 'Worldwide';
  // Hourly block header: '### <date>' (rich) or bare '<date>' (stripped).
  // Anchor on the date core; tolerate ANY paren note (e.g. '(UTC)' instead of
  // '(Coordinated Universal Time)'), NBSP whitespace, and trailing text after
  // the paren — so gateway normalization of the tz string cannot silently
  // re-break the mirror leg (round-2 reviewer finding 1).
  const headRe = /^[ \t]*(?:#{1,6}[ \t]+)?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+\d{1,2}[ \t]+\d{4}[ \t]+\d{2}:\d{2}:\d{2}[ \t]+GMT[+-]?\d*)(?:[\s\u00a0]*\([^)]*\))?[ \t]*.*$/m;
  const head = headRe.exec(md);
  if (!head || head.index === undefined) return null;
  const timestamp = head[1].trim();
  const rest = md.slice(head.index + head[0].length);
  // Items: numbered '1.  [name](url)' (rich) or bare '[name](url)' (stripped).
  // Bare items are restricted to X search links (twitter.com / x.com / their
  // subdomains, per round-2 reviewer finding 2) so promo/nav links (trends24.in,
  // archive.trends24.in, twitter.com/_trends24) can never be collected as
  // trends. The numbered rich shape keeps accepting any URL, as before.
  const numberedItem = /^\s*\d+\.\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
  const bareItem = /^\s*\[([^\]]+)\]\((https?:\/\/(?:[a-z]+\.)?(?:twitter\.com|x\.com)\/search\?q=[^)\s]+)\)/;
  const items: Array<{ name: string; url: string }> = [];
  for (const line of rest.split('\n')) {
    const m = numberedItem.exec(line) ?? bareItem.exec(line);
    if (m) {
      items.push({ name: m[1].replace(/\\_/g, '_').trim(), url: m[2] });
      continue;
    }
    if (items.length > 0 && line.trim() === '') continue; // tolerate blank lines inside the block
    if (items.length > 0) break; // first non-item content after items → block ended
  }
  if (items.length < 5) return null;
  return { region, timestamp, items };
}

/** Injectable seams (tests). */
export interface TrendsDeps {
  scrape?: (url: string) => Promise<string>;
}

async function getTrendsViaMirror(
  woeid: string | undefined,
  scrape: (url: string) => Promise<string>,
): Promise<string | null> {
  const mapped = woeid !== undefined ? WOEID_TO_TRENDS24_SLUG[woeid] : '';
  const slug = mapped ?? ''; // unknown WOEID → worldwide root (noted in the output)
  const url = `https://trends24.in/${slug ? `${slug}/` : ''}`;
  const md = await scrape(url);
  if (scrapeFailureReason(md)) return null;
  const snap = parseTrends24(md);
  if (!snap) return null;
  const regionNote = woeid !== undefined && mapped === undefined
    ? ` (requested WOEID ${woeid} has no verified mirror region — showing ${snap.region})`
    : '';
  const list = snap.items.slice(0, 30).map((it, i) => `${i + 1}. [${it.name}](${it.url})`);
  return [
    `# X trends — ${snap.region}${regionNote} (latest hourly snapshot)`,
    '',
    `_via the trends24.in mirror of X's trending list — x.com's own trends page blocks unauthenticated scraping (X anti-bot). Snapshot: ${snap.timestamp}._`,
    '',
    ...list,
  ].join('\n');
}

export async function getTrends(woeid?: string, deps: TrendsDeps = {}): Promise<string> {
  // X API v2 has no usable trends endpoint for non-enterprise apps, so trends
  // stay on the scrape path even when an OAuth token is attached.
  //
  // MIRROR-FIRST (ticket 11d98377, 2026-10-10): the x.com/explore scrape is
  // wall/empty for unauthenticated fetchers in EVERY observation since the
  // mirror leg shipped (23c68866: "x.com/explore is wall/empty for scrapers";
  // its round-3 structural gate exists precisely because x.com serves walls).
  // Running it FIRST cost the whole scrape budget (25–40 s, cap 75 s) on a leg
  // that nearly always fails, BEFORE the mirror that nearly always works —
  // and this call rides the controller's integration PREFETCH, which the
  // backend fully awaits before the model run starts, so the wasted leg was
  // first-word latency on every "trending on X" turn (the nightly suite's
  // 49.7 s Quick-lane breach). Try the trends24.in mirror first; scrape
  // x.com/explore only when the mirror itself yields nothing (outage, parse
  // drift) so the x.com leg survives as the fallback, not the toll.
  const scrape = deps.scrape ?? callScrapeAsMarkdown;
  const viaMirror = await getTrendsViaMirror(woeid, scrape);
  if (viaMirror) return viaMirror;

  const path = woeid ? `/explore/tabs/trending/${encodeURIComponent(woeid)}` : '/explore/tabs/trending';
  const md = await scrape(`https://x.com${path}`);
  const wall = detectXWall(md);
  const failed = scrapeFailureReason(md);
  // Structural gate (round 3): serve the x.com scrape only when it actually
  // looks like a trending page — dense with X search links. X localizes its
  // login wall per exit node, so an unobserved-locale wall can evade every
  // marker, but no wall variant carries trend search links.
  if (!wall && !failed && countXSearchLinks(md) >= 3) {
    return `# X trends${woeid ? ` (WOEID ${woeid})` : ''}\n\n${trimMarkdown(md, 6000)}`;
  }
  const why = wall ?? (failed
    ? `an unusable response (${failed})`
    : 'unrecognized page (no trends list found — possibly a login wall in an unobserved locale; X localizes its wall per exit node)');
  return degradedRead('X trending topics', why);
}
