/**
 * SERP redirect-wrapper unwrapping (owner 2026-09-14: "is our web_pipe broken??").
 *
 * Since ~2026-09-13 20:00Z BrightData's `search_engine` SERP JSON returns
 * `organic[].link` as Google redirect WRAPPERS —
 * `https://www.google.com/goto?url=CAES…` (an opaque token, NOT a decodable
 * URL; `display_link` carries only the domain). Downstream that broke two
 * things at once:
 *
 *   - `scrape_as_markdown` on a wrapper answers the 30-char body
 *     "this endpoint is not supported" → every web_pipe read 0 of its sources
 *     ("web_pipe could not read any of the 4 source(s)" — 13 such tool
 *     results in ONE prod hour);
 *   - chat / coding search_engine tool results (and the [Web Search Results]
 *     blocks) handed the models goto URLs, so citations carried wrappers.
 *
 * A direct GET of the wrapper with `maxRedirects:0` and a browser UA answers
 * HTTP 302 with `Location: <the real URL>` (no referrer needed), so the fix is
 * ONE redirect hop per wrapper, resolved once per process (LRU, 6 h), with
 * bounded concurrency, never throwing — a wrapper that cannot be resolved is
 * returned unchanged (status quo ante). Locally-decodable shapes (Google
 * `/url?q=`, Bing `/ck/a?u=a1<base64url>`, DuckDuckGo `/l/?uddg=`) are
 * decoded without a network hop.
 *
 * Wired at three places:
 *   - `mcp-search.ts callMcpTool('search_engine')` — the chokepoint every SERP
 *     consumer reads through (chat + coding tool results, [Web Search Results]
 *     blocks, news, kid path, web_pipe, youtube_pipe);
 *   - `coding/web-pipe.ts runWebPipe` — right after `topLinks`, before the
 *     scrape, so sources / RAG refs / same-host grouping see the REAL URL even
 *     when the SERP came from elsewhere;
 *   - `coding/youtube-pipe.ts runYoutubePipe` — a wrapped YouTube link has no
 *     extractable video id, so the pipe would silently find zero videos.
 */

import axios from 'axios';
import logger from '../../utils/logger';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 6;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;      // a resolved wrapper stays resolved
const CACHE_NEGATIVE_TTL_MS = 5 * 60 * 1000;  // an unresolvable one is retried after a short cooldown
const HOP_MAX_BODY_BYTES = 64 * 1024;         // a 3xx has no meaningful body; a 200 gets cut off, not read
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Cheap textual pre-check so a 200k-char SERP is not JSON-parsed on every
 *  search when it carries no wrapper at all. Tolerates JSON-escaped slashes. */
const WRAPPER_HINT_RE = /(?:google\.[a-z.]{2,10}\\?\/(?:goto|url)\?|bing\.com\\?\/ck\\?\/a\?|duckduckgo\.com\\?\/l\\?\/?\?)/i;

function parseHttpUrl(s: unknown): URL | null {
  if (typeof s !== 'string' || !s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const GOOGLE_HOST_RE = /^(?:[a-z0-9-]+\.)*google\.(?:[a-z]{2,3}|[a-z]{2,3}\.[a-z]{2})$/i;
const BING_HOST_RE = /^(?:[a-z0-9-]+\.)*bing\.com$/i;
const DDG_HOST_RE = /^(?:[a-z0-9-]+\.)*duckduckgo\.com$/i;

type WrapperKind = 'google-goto' | 'google-url' | 'bing-ck' | 'ddg-l';

function classifyWrapper(u: URL): WrapperKind | null {
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (GOOGLE_HOST_RE.test(host)) {
    if (path === '/goto' && u.searchParams.has('url')) return 'google-goto';
    if (path === '/url' && (u.searchParams.has('q') || u.searchParams.has('url'))) return 'google-url';
    return null;
  }
  if (BING_HOST_RE.test(host) && path === '/ck/a' && u.searchParams.has('u')) return 'bing-ck';
  if (DDG_HOST_RE.test(host) && path === '/l' && u.searchParams.has('uddg')) return 'ddg-l';
  return null;
}

/**
 * True for the search-engine redirect shapes we know: Google `/goto?url=` and
 * `/url?q=|url=` (any google.<tld>), Bing `/ck/a?u=`, DuckDuckGo `/l/?uddg=`.
 * A plain result URL — including google.com/search itself — is NOT a wrapper.
 */
export function isSerpRedirectWrapper(url: string): boolean {
  const u = parseHttpUrl(url);
  return !!u && classifyWrapper(u) !== null;
}

/** Base64url (Bing's `u=a1…` payload) → utf8, or null on garbage. */
function base64UrlDecode(s: string): string | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve a wrapper WITHOUT a network hop when the target rides inside the
 * wrapper itself. Returns the real http(s) URL, or null when the shape is
 * opaque (Google `/goto?url=CAES…`) or the payload is not a usable URL.
 * Exported for unit tests; callers use unwrapSerpRedirect.
 */
export function decodeSerpRedirectLocally(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u) return null;
  const kind = classifyWrapper(u);
  if (!kind) return null;
  let candidate: string | null = null;
  switch (kind) {
    case 'google-goto':
      candidate = u.searchParams.get('url');
      break;
    case 'google-url':
      candidate = u.searchParams.get('q') || u.searchParams.get('url');
      break;
    case 'bing-ck': {
      const raw = u.searchParams.get('u') || '';
      candidate = raw.startsWith('a1') ? base64UrlDecode(raw.slice(2)) : null;
      break;
    }
    case 'ddg-l':
      candidate = u.searchParams.get('uddg');
      break;
  }
  const target = parseHttpUrl(candidate);
  if (!target || classifyWrapper(target) !== null) return null; // opaque token, junk, or wrapper-in-wrapper
  return target.href;
}

// ── Per-process LRU (Map keeps insertion order; refresh on hit) ──────────────
interface CacheEntry { value: string; resolved: boolean; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<{ value: string; resolved: boolean }>>();

function cacheGet(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key); // refresh recency
  cache.set(key, e);
  return e;
}

function cacheSet(key: string, value: string, resolved: boolean): void {
  cache.delete(key);
  cache.set(key, { value, resolved, expiresAt: Date.now() + (resolved ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS) });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam — the cache is process-global by design. */
export function clearSerpRedirectCache(): void {
  cache.clear();
  pending.clear();
}

/** Test/observability seam. */
export function serpRedirectCacheSize(): number {
  return cache.size;
}

/**
 * ONE redirect hop: GET with maxRedirects:0 and a browser UA; accept any
 * status; return the absolute Location (resolved against the wrapper) when the
 * status is a redirect and the target is http(s) and not itself a wrapper.
 * Anything else (200, 4xx/5xx, non-http Location, wrapper chain, timeout,
 * network error) → null.
 */
async function followOneHop(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const r = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: timeoutMs,
      responseType: 'text',
      transformResponse: [(d: any) => d],
      maxContentLength: HOP_MAX_BODY_BYTES,
      maxBodyLength: HOP_MAX_BODY_BYTES,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!REDIRECT_STATUSES.has(Number(r?.status))) return null;
    const headers: any = r?.headers || {};
    const location = headers.location ?? headers.Location;
    if (typeof location !== 'string' || !location.trim()) return null;
    let target: URL;
    try {
      target = new URL(location.trim(), url); // relative Location resolves against the wrapper
    } catch {
      return null;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (classifyWrapper(target) !== null) return null; // redirect to another wrapper — not a real page
    return target.href;
  } catch {
    return null;
  }
}

async function resolveWrapper(url: string, timeoutMs: number): Promise<{ value: string; resolved: boolean }> {
  const local = decodeSerpRedirectLocally(url);
  if (local) return { value: local, resolved: true };
  const hop = await followOneHop(url, timeoutMs);
  return hop ? { value: hop, resolved: true } : { value: url, resolved: false };
}

/** Resolve one wrapper with cache + in-flight dedup. Never throws. */
async function unwrapWithMeta(url: string, timeoutMs: number): Promise<{ value: string; resolved: boolean; cached: boolean }> {
  const hit = cacheGet(url);
  if (hit) return { value: hit.value, resolved: hit.resolved, cached: true };
  let p = pending.get(url);
  if (!p) {
    p = resolveWrapper(url, timeoutMs)
      .catch(() => ({ value: url, resolved: false }))
      .then(res => {
        cacheSet(url, res.value, res.resolved);
        return res;
      })
      .finally(() => { pending.delete(url); });
    pending.set(url, p);
  }
  const res = await p;
  return { ...res, cached: false };
}

/**
 * Unwrap ONE URL. Non-wrappers (and everything when the kill switch is on)
 * come back unchanged with no network. A wrapper that cannot be resolved comes
 * back unchanged too — never throws.
 */
export async function unwrapSerpRedirect(url: string, opts?: { timeoutMs?: number }): Promise<string> {
  if (typeof url !== 'string' || !isSerpRedirectWrapper(url)) return url;
  try {
    return (await unwrapWithMeta(url, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)).value;
  } catch {
    return url;
  }
}

/**
 * Unwrap a list of `{ url }` items, preserving order and every other field.
 * Only wrapper entries touch the network, at most `concurrency` at a time.
 * Logs ONE info line per batch that had wrappers (counts). Never throws.
 */
export async function unwrapSerpLinks<T extends { url: string }>(
  items: T[],
  opts?: { concurrency?: number; timeoutMs?: number },
): Promise<T[]> {
  if (!Array.isArray(items) || items.length === 0) return items;
  const out = items.slice();
  const wrapperIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (typeof items[i]?.url === 'string' && isSerpRedirectWrapper(items[i].url)) wrapperIdx.push(i);
  }
  if (!wrapperIdx.length) return out;

  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? DEFAULT_CONCURRENCY));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let resolved = 0;
  let cached = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < wrapperIdx.length) {
      const i = wrapperIdx[cursor++];
      try {
        const res = await unwrapWithMeta(items[i].url, timeoutMs);
        if (res.resolved) resolved++;
        if (res.cached) cached++;
        out[i] = { ...items[i], url: res.value };
      } catch {
        /* keep the original item — never throw from a batch */
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, wrapperIdx.length) }, worker));
  } catch {
    /* workers swallow their own errors; belt and braces */
  }
  const failed = wrapperIdx.length - resolved;
  logger.info(
    `serp-redirects: unwrapped ${resolved}/${wrapperIdx.length} SERP redirect wrapper(s) in a batch of ${items.length}` +
    (cached ? ` (${cached} from cache)` : '') +
    (failed ? ` — ${failed} unresolved, kept as-is` : ''),
  );
  return out;
}

/**
 * Rewrite the `link` of every item in the SERP JSON's top-level result arrays
 * (`organic`, `news`, `videos`, …) that is a redirect wrapper, returning the
 * SERP text with real URLs. Everything else in the payload is preserved;
 * unparseable text, or a SERP with no wrappers, is returned byte-identical.
 * Never throws.
 */
export async function unwrapSerpJsonText(serpText: string, opts?: { concurrency?: number; timeoutMs?: number }): Promise<string> {
  if (typeof serpText !== 'string' || !serpText) return serpText;
  if (!WRAPPER_HINT_RE.test(serpText)) return serpText;
  try {
    // BrightData's brd_json body is pure JSON; tolerate a stray non-JSON prefix
    // (kept verbatim) the way news.service's extractor does.
    let prefix = '';
    let parsed: any;
    try {
      parsed = JSON.parse(serpText);
    } catch {
      const start = serpText.indexOf('{');
      if (start < 0) return serpText;
      prefix = serpText.slice(0, start);
      parsed = JSON.parse(serpText.slice(start));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return serpText;

    const refs: Array<{ url: string; item: any }> = [];
    for (const value of Object.values(parsed)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.link === 'string' && isSerpRedirectWrapper(item.link)) {
          refs.push({ url: item.link, item });
        }
      }
    }
    if (!refs.length) return serpText;

    const unwrapped = await unwrapSerpLinks(refs, opts);
    let changed = 0;
    for (const r of unwrapped) {
      if (r.url !== r.item.link) {
        r.item.link = r.url;
        changed++;
      }
    }
    if (!changed) return serpText;
    return prefix + JSON.stringify(parsed);
  } catch {
    return serpText;
  }
}
