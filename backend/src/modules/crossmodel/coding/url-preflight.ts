/**
 * url-preflight.ts (BS-1 D4/D5, 2026-11-02) — the scrape tool's URL hygiene.
 *
 * TWO defects this closes, both from the Polk County / Facebook-Ad-Library runs
 * (goal 9ecd595e WRP-1 D5-R is the first; the second is its sibling):
 *
 *  D5 — NO URI PRE-FLIGHT. A truncated URL the model pasted out of a search
 *  snippet (`https://www.facebook.com/ads/library/?acti`) was dispatched
 *  verbatim and came back as a raw BrightData gateway
 *  `HTTP 400 {"error":"Request validation failed","url" must be a valid uri}`.
 *  That reads to the model as an infrastructure failure, not as "the link you
 *  typed is incomplete" — so it retries, or reports the site as broken. A URL
 *  that is OBVIOUSLY incomplete must fail here, before dispatch, saying so.
 *
 *  D4 — A GUESSED PATH IS FETCHED AND ITS 404 REPORTED AS "SITE DOWN".
 *  `resolveDomainUrl` (web-search-route.ts) already existed and was already
 *  tested, but nothing called it: the tool fetched whatever URL the model
 *  supplied, and a fabricated path that 404s became "the page may be
 *  unavailable, blocked, or rate-limited" — i.e. "the source is down". The
 *  ladder below is what the primitive was written for: on an empty scrape, ask
 *  the SERP what the REAL url for that domain is, retry it once, and when
 *  nothing resolves say NOT FOUND for that domain — never "down".
 *
 * Both behaviours sit behind one kill switch each (documented on the exports).
 * This module is a PURE LEAF plus one orchestrator with injected I/O, so every
 * decision is pinnable in a test without a network.
 */

import { officialUrlSearchQuery, resolveDomainUrl } from './web-search-route';

/** Kill switch (BS-1 D5): =1 disables the incomplete-URL pre-flight. */
export const uriPreflightDisabled = (): boolean => process.env.WEB_TOOL_URI_PREFLIGHT_DISABLED === '1';
/** Kill switch (BS-1 D4): =1 disables the domain-resolve retry ladder. */
export const domainResolveDisabled = (): boolean => process.env.SCRAPE_DOMAIN_RESOLVE_DISABLED === '1';

export interface UrlVerdict {
  ok: boolean;
  /** Why the URL is unusable, in words the MODEL can act on. */
  reason?: string;
  /** The machine-readable class, for tests and telemetry. */
  kind?: 'empty' | 'not_a_url' | 'bad_scheme' | 'incomplete';
  /** The host when the URL at least parsed (the domain-resolve ladder's input). */
  host?: string;
}

/**
 * Is this URL OBVIOUSLY incomplete — i.e. cut off mid-write rather than simply
 * wrong? Deliberately conservative: only shapes that no real endpoint produces.
 *
 *   1. a dangling `?` or `&` with nothing after it;
 *   2. a query string whose LAST parameter has no `=` — `?acti` is the
 *      canonical case (every real query param on a scrape target carries a
 *      value; a bare trailing key is a trimmed snippet);
 *   3. an unfinished percent-escape (`%`, `%2`) at the very end;
 *   4. a truncated scheme / a bare word that is not a URL at all.
 *
 * Every rule is a shape at the END of the string — which is exactly what a
 * truncation leaves behind. Rules 1–3 are skipped entirely when the caller's
 * kill switch is on.
 *
 * Rule 2 is the one rule that can be WRONG about a complete URL: a bare
 * trailing query key is a standard web idiom, so see UrlPreflightOptions.
 */
export interface UrlPreflightOptions {
  allowBareTrailingKey?: boolean;
}

export function looksIncompleteUrl(raw: string, opts: UrlPreflightOptions = {}): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  // Rule 4 first: without a scheme+host there is nothing to fetch.
  if (!/^https?:\/\/[^\s/?#]+/i.test(s)) return true;
  if (uriPreflightDisabled()) return false;
  if (/\s/.test(s)) return true;                       // a space means it was pasted mid-sentence
  if (/[?&]$/.test(s)) return true;                    // rule 1 — dangling ? or &
  if (/%[0-9a-f]?$/i.test(s)) return true;             // rule 3 — half a percent-escape
  if (!opts.allowBareTrailingKey) {
    const q = s.indexOf('?');
    if (q >= 0) {
      const qs = s.slice(q + 1).split('#')[0];         // query only, fragment excluded
      if (qs) {
        const last = qs.split('&').filter(Boolean).pop() ?? '';
        if (last && !last.includes('=')) return true;  // rule 2 — `?acti` (see caveat above)
      }
    }
  }
  return false;
}

/** The complete pre-flight: usable? scheme? incomplete? — one call. */
export function preflightUrl(raw: string, opts: UrlPreflightOptions = {}): UrlVerdict {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, kind: 'empty', reason: 'No url provided.' };
  // Scheme is checked BEFORE shape: `file:///etc/passwd` is a complete, valid URL
  // that we simply refuse — reporting it as "truncated" would be a lie.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, kind: 'bad_scheme', reason: `Only http(s) URLs can be scraped (got "${s.slice(0, 60)}").` };
  }
  if (!scheme) {
    // No scheme at all: a bare host or a fragment of one — reads as a truncated
    // paste, so hand back the search-again hint rather than a scheme complaint.
    return { ok: false, kind: 'not_a_url', reason: incompleteUrlMessage(s) };
  }
  let host = '';
  try { host = new URL(s).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* handled below */ }
  if (looksIncompleteUrl(s, opts)) {
    return { ok: false, kind: 'incomplete', host, reason: incompleteUrlMessage(s) };
  }
  return { ok: true, host };
}

/**
 * The message the model sees for a truncated URL — actionable, and explicitly
 * NOT an infrastructure error, so it searches for the full link instead of
 * concluding the site is down or hammering the same bad URL.
 */
export function incompleteUrlMessage(raw: string): string {
  const s = String(raw ?? '').trim();
  return `The URL "${s.slice(0, 120)}" looks INCOMPLETE — it was cut off (a dangling "?"/"&", `
    + 'a query parameter with no value, or half a percent-escape). Nothing was fetched. '
    + 'This is not the site being down. Get the full link — re-run the search and copy the '
    + 'whole URL, or use the site\'s own page path — then scrape that.';
}

/**
 * The message for an EMPTY scrape after both legs failed. Says NOT FOUND for a
 * domain / "no content", never "the site is down" (BS-1 D4).
 */
export function notFoundMessage(rawUrl: string, domain: string, resolvedUrl?: string | null): string {
  const where = domain ? `on ${domain}` : `at ${rawUrl.slice(0, 100)}`;
  const tried = resolvedUrl && resolvedUrl !== rawUrl
    ? ` I also tried the URL the search engine actually indexes for that domain (${resolvedUrl.slice(0, 120)}), which returned nothing.`
    : ' A domain-scoped search found no working page for that domain either.';
  return `Nothing was found ${where} — the path in the URL did not return readable content.${tried} `
    + 'That is NOT the same as the site being down. Either the path is wrong (re-check it against the '
    + 'search result), or the page renders only in a browser and cannot be scraped — say which, and '
    + 'answer from the search results you already have rather than retrying this URL.';
}

export interface ScrapeLadderDeps {
  /** The direct scrape, exactly as the tool already performs it. */
  scrape: (url: string) => Promise<string | null>;
  /** Run ONE search and return its SERP text (null = search unavailable). */
  search: (query: string) => Promise<string | null>;
}

export type ScrapeLadderResult =
  | { ok: true; markdown: string; via: 'direct' | 'resolved'; resolvedUrl?: string }
  | { ok: false; message: string; resolvedUrl?: string | null; searched: boolean };

/**
 * Fetch one URL, and when it comes back empty, resolve the domain's REAL url
 * through the search engine and retry once (BS-1 D4).
 *
 * This is the wiring `resolveDomainUrl` was written for. Note what it does NOT
 * do: it never reports "down", and it never loops — exactly one retry, on the
 * single best URL the SERP names for that domain.
 */
export async function scrapeViaDomainResolve(
  rawUrl: string,
  deps: ScrapeLadderDeps,
): Promise<ScrapeLadderResult> {
  const direct = await deps.scrape(rawUrl);
  if (direct && direct.trim()) return { ok: true, markdown: direct, via: 'direct' };

  const verdict = preflightUrl(rawUrl);
  const domain = verdict.host ?? '';
  // No host, or the ladder switched off → the caller's own not-found copy.
  if (!domain || domainResolveDisabled()) {
    return { ok: false, message: notFoundMessage(rawUrl, domain, null), searched: false };
  }

  let serp: string | null = null;
  try {
    serp = await deps.search(officialUrlSearchQuery(domain));
  } catch {
    serp = null; // a search failure is not a scrape failure — fall through
  }
  const resolvedUrl = serp ? resolveDomainUrl(serp, domain) : null;

  if (resolvedUrl && resolvedUrl !== rawUrl) {
    const retried = await deps.scrape(resolvedUrl);
    if (retried && retried.trim()) {
      return { ok: true, markdown: retried, via: 'resolved', resolvedUrl };
    }
    return { ok: false, message: notFoundMessage(rawUrl, domain, resolvedUrl), resolvedUrl, searched: true };
  }
  return { ok: false, message: notFoundMessage(rawUrl, domain, null), resolvedUrl, searched: true };
}