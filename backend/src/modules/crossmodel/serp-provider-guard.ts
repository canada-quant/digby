/**
 * SERP provider-error guard (ticket 9b944f30, 2026-10-07).
 *
 * BrightData's MCP search tier intermittently wraps a provider failure (429
 * sr_rate_limit auto-throttle, 502 with x-brd-error-code, a challenge page)
 * as a SUCCESSFUL tool result whose text is the error body — usually linking
 * the vendor's own troubleshooting docs. web_pipe's SERP parser then fell
 * back to raw-URL extraction, scraped https://docs.brightdata.com/… as the
 * sole "source", stored it to session RAG and digested it as a HEALTHY
 * result: a "successful" web_pipe call whose sources were the search
 * provider's own documentation (recurring since 2026-09-25; live repro in
 * the ticket — an inflatable-dome stock query "digested" the SERP API
 * debugging page). The direct REST tier already validates the SERP shape
 * (the `"organic":` sanity check in brightdata-direct.ts
 * directSearchEngine), but the gateway tier resolved the MCP content text
 * with no validation, so the poison always arrived via that tier.
 *
 * This module is the shared, PURE detection layer:
 *   - isProviderSourceUrl(url): the search provider's own hosts are never a
 *     valid SEARCH-DERIVED source (web_pipe's non-JSON fallback extracts raw
 *     URLs out of the SERP text, which is exactly where the vendor's docs
 *     link leaked in). Explicitly GIVEN urls are the model's own choice and
 *     are not filtered anywhere — only the search path is.
 *   - serpProviderErrorDetail(text): classifies a "SERP" response that is
 *     actually a provider error body and extracts the code / req_id / HTTP
 *     status so callers can surface them (throttle vs. query-block) and
 *     decide retryability. A body that parses (index-0 or after a stray
 *     prefix, the serp-redirects idiom) as JSON carrying an organic[] array
 *     is a real result set by definition and NEVER matches, so a legitimate
 *     query about BrightData (whose organic hits are docs.brightdata.com)
 *     stays healthy.
 *   - serpBackendFailedSummary(e): the explicit failure text web_pipe returns
 *     INSTEAD of a digest, naming the provider error code so the caller can
 *     tell a throttle (retry after backoff) from a query-block (rephrase).
 *
 * Trigger strength (adversarial review, 2026-10-07): STRONG — the header
 * form `x-brd-error-code: <code>` (either header spelling), which is never
 * ordinary page content, fires standalone. WEAK — a bare catalog word or
 * "auto-throttled" phrasing fires ONLY when a vendor anchor co-occurs (the
 * header NAME, a link into brightdata.com, or a req_id= debug token):
 * "Verifying your domain" is ordinary English and a healthy non-JSON SERP
 * snippet can carry it, as can an article about API throttling — a probe
 * proved the unanchored form killed healthy searches. An error body that
 * prints a bare code with zero other vendor signal falls to web_pipe's
 * layer-2 host filter / zero-source note — still never ingested.
 *
 * Code catalog source: docs.brightdata.com/scraping-automation/serp-api/
 * debugging (the very page that kept being ingested). 429 family:
 * sr_rate_limit / bucket_rate_limit / failed_query_rejected /
 * repeat_query_rejected / client_10110 (rate limits — retryable after the
 * stated wait; the vendor documents a 15 s floor for the query-level bans).
 * 502 family: unexpected_q (query mismatch — deterministic, retrying the
 * identical query fails identically) and verifying (challenge page — retry
 * after ≥15 s).
 *
 * RSW-1 (2026-10-30, goal 393f731e): the SERP_PROVIDER_GUARD_DISABLED switch
 * is GONE — it was inert in prod (no compose file forwarded it, 0 hits), so
 * the guarded reading was the only one that ever ran.
 */

/** hostname is brightdata.com or any subdomain of it (NOT
 *  brightdata.com.evil.com — the regex anchors on hostname segments). */
const PROVIDER_HOST_RE = /(^|\.)brightdata\.com$/i;

/** True when the URL belongs to the search provider itself — never a valid
 *  SEARCH-DERIVED source. False on unparseable input. */
export function isProviderSourceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROVIDER_HOST_RE.test(host);
  } catch {
    return false;
  }
}

export interface SerpProviderError {
  /** x-brd-error-code value (or a bare known catalog code found in the text). */
  code?: string;
  /** HTTP status when the body quotes one (429 / 502 / 503 …). */
  status?: number;
  /** req_id=… from the provider's debug header dump, for bug reports. */
  reqId?: string;
  /** Provider-stated minimum wait before a retry can succeed
   *  (x-brd-rate-limit-period-ms, or the vendor-documented 15 s floor for
   *  the query-level bans) — 0/undefined when the body states none. */
  minWaitMs?: number;
  /** false only for the deterministic query-mismatch class (unexpected_q):
   *  retrying the identical query fails identically, so fail fast instead. */
  retryable: boolean;
  /** Whitespace-collapsed body head — for the log line, not the user summary. */
  snippet: string;
}

/** A "successful" tools/call answer whose text IS the provider's error body —
 *  thrown by mcp-search's gateway tier so the existing retry/backoff +
 *  circuit-breaker loop treats it as a FAILED attempt (ticket ca805a61).
 *  Carries the classified detail so the terminal log line and any caller
 *  callback can name the code (throttle vs query-block) without re-running
 *  the classifier. */
export class SerpProviderErrorBodyError extends Error {
  constructor(public readonly detail: SerpProviderError) {
    super(
      `search backend answered with an error/debug body instead of results` +
        (detail.code ? ` (x-brd-error-code=${detail.code})` : '') +
        (detail.status ? ` HTTP ${detail.status}` : '') +
        (detail.reqId ? ` req_id=${detail.reqId}` : ''),
    );
    this.name = 'SerpProviderErrorBodyError';
  }
}

/** Options for callMcpTool('search_engine' | …). onSerpProviderError fires
 *  whenever a tier classifies a provider-error body and nulls/fails it, so a
 *  caller that wants the DIAGNOSIS (not just the honest null) can surface it
 *  (web_pipe names the code; youtube_pipe names the zero-target cause). It
 *  may fire more than once per call (once per failed attempt) — the FIRST
 *  detail is the attempt-1 diagnosis; callers keep the first. */
export interface SerpCallOpts {
  onSerpProviderError?: (detail: SerpProviderError) => void;
  /**
   * RESUME-AFTER-THROTTLE BUDGET (D3, 2026-10-31, goal 9ecd595e).
   *
   * The default contract is deliberately FAIL-FAST: a throttle that states a
   * minimum wait beyond `SERP_PROVIDER_RETRY_WAIT_CAP_MS` (8 s) returns `null`
   * at once rather than parking an INTERACTIVE tool call ~30–60 s waiting out a
   * ban (ticket ca805a61, shard-3 — pinned by test). That is right for a single
   * human-facing lookup and wrong for a long-budget research call, which would
   * rather wait than answer "search failed".
   *
   * A caller that can afford to wait passes a total wall-clock budget here and
   * gets the D3 ladder: the stated throttle wait is HONOURED (up to the budget,
   * never unbounded), the SAME logical request is re-sent — `callMcpToolOnce`
   * already re-sends identical `args`, so resuming needs no new transport — and
   * the call returns real results instead of surfacing a provider error.
   *
   * Absent/0 = today's behaviour, byte-for-byte. The provider's error body is
   * NEVER returned as results either way: the ca805a61 pin holds.
   */
  resumeBudgetMs?: number;
  /**
   * WHICH gateway MCP session this call runs on (ticket 5f69fdc4).
   *
   * The gateway is stateful (`supergateway --stateful`): one stdio child — and
   * therefore one BrightData browser — per `Mcp-Session-Id`. Search/scrape
   * share the default key; the cloud BROWSER driver passes its own per-run key
   * so `navigate → snapshot → get_text → click_ref` all hit the SAME page.
   * Absent = the default web-session key (byte-identical behaviour for every
   * existing caller).
   */
  sessionKey?: string;
  /**
   * WHICH gateway MOUNT this call goes to (ticket 5f69fdc4). The interactive
   * cloud browser uses the STATEFUL `/browser/mcp`; everything else keeps the
   * shared, stateless `/mcp` (a stateful instance 400s session-less POSTs, and
   * x-mcp is a live session-less client of `/mcp`). Absent = `MCP_DIGBY_URL`.
   */
  gatewayUrl?: string;
}

/** Known catalog codes. unexpected_q is the only DETERMINISTIC one (query
 *  mismatch — the same query fails the same way); everything else is a
 *  throttle / challenge / unknown class worth one bounded retry. */
const DETERMINISTIC_CODES = new Set(['unexpected_q']);
const KNOWN_CODE_RE =
  /\b(sr_rate_limit|bucket_rate_limit|failed_query_rejected|repeat_query_rejected|client_10110|unexpected_q|verifying)\b/i;
/** `x-brd-error-code: sr_rate_limit` / `x-brd-err-code=sr_rate_limit` /
 *  `"x-brd-error-code":"sr_rate_limit"` — the header name printed in the
 *  provider's error dumps (client_10110 arrives via x-brd-err-code, so both
 *  spellings are accepted, per the provider's own docs). STRONG standalone
 *  trigger: this literal header text is never ordinary page content. */
const BRD_HEADER_CODE_RE = /x-brd-(?:err|error)-code["']?\s*[:=]\s*["']?([a-z0-9_]+)/i;
/** The header NAME alone (a malformed/blank header) — a vendor anchor. */
const BRD_HEADER_NAME_RE = /x-brd-(?:err|error)-code/i;
const AUTO_THROTTLE_RE = /auto-throttl/i;
const REQ_ID_RE = /req_id=([A-Za-z0-9_.-]+)/;
const PROVIDER_LINK_RE = /https?:\/\/(?:[a-z0-9-]+\.)*brightdata\.com\//i;
/** `x-brd-rate-limit-period-ms: 60000` — the retry-wait period the provider
 *  states on rate-limit responses (capped: only sane values steer a retry). */
const PERIOD_MS_RE = /x-brd-rate-limit-period-ms["']?\s*[:=]\s*["']?(\d{1,7})/i;
const HTTP_STATUS_RES = [
  /HTTP\/[\d.]+\s+(\d{3})\b/i,
  /HTTP\s+Error\s+(\d{3})\b/i,
  /\b(?:http|status)[=:]\s*(\d{3})\b/i,
];
/** Query-level ban codes: the vendor documents a 15-second floor ("that
 *  query is banned for 15 seconds and immediate retries fail as well"). */
const QUERY_BAN_CODES = new Set(['failed_query_rejected', 'repeat_query_rejected', 'verifying']);
const QUERY_BAN_MIN_WAIT_MS = 15_000;

/** A body that parses as JSON (index-0, or after a stray non-JSON prefix —
 *  the serp-redirects unwrapSerpJsonText idiom) carrying an organic[] array
 *  is a real result set — never an error page, even when its snippets
 *  mention provider error codes (a legitimate query ABOUT BrightData errors
 *  returns exactly those pages as results). */
export function serpCarriesOrganic(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  const tryParse = (s: string): any | undefined => {
    try { return JSON.parse(s); } catch { return undefined; }
  };
  let parsed = tryParse(text);
  if (parsed === undefined) {
    const start = text.indexOf('{');
    if (start < 0) return false;
    parsed = tryParse(text.slice(start)); // tolerate a stray non-JSON prefix
  }
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.organic);
}

/**
 * Classify a "SERP" response that is actually the provider's error body.
 * Returns the extracted detail (code / req_id / status / retryability), or
 * null when the text looks like real results. Pure; never throws; the kill
 * switch always reports null. Detection is deliberately BrightData-specific
 * so ordinary pages that merely mention throttling never match: STRONG — the
 * `x-brd-error-code:` header form (standalone); WEAK — bare catalog words
 * and "auto-throttled" phrasing, only with a vendor anchor (header name,
 * brightdata.com link, or req_id) co-occurring.
 */
export function serpProviderErrorDetail(text: string): SerpProviderError | null {
  if (!text) return null;
  if (serpCarriesOrganic(text)) return null;
  const s = String(text);
  const headerCode = BRD_HEADER_CODE_RE.exec(s)?.[1];
  const bareCode = KNOWN_CODE_RE.exec(s)?.[1];
  const reqId = REQ_ID_RE.exec(s)?.[1];
  const autoThrottled = AUTO_THROTTLE_RE.test(s);
  const providerLink = PROVIDER_LINK_RE.test(s);
  // STRONG: the header form fires standalone. WEAK: a bare catalog word or
  // the auto-throttle phrase needs a vendor anchor — "Verifying your domain"
  // and "how APIs auto-throttle" are ordinary healthy-page English.
  const anchored = BRD_HEADER_NAME_RE.test(s) || providerLink || !!reqId;
  const detected = !!headerCode || (anchored && !!(bareCode || autoThrottled));
  if (!detected) return null;
  const code = headerCode || (anchored ? bareCode : undefined);
  let status: number | undefined;
  for (const re of HTTP_STATUS_RES) {
    const m = re.exec(s);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 400 && n < 600) { status = n; break; }
    }
  }
  const codeLc = String(code || '').toLowerCase();
  const periodMs = PERIOD_MS_RE.exec(s) ? parseInt(PERIOD_MS_RE.exec(s)![1], 10) : undefined;
  const minWaitMs = Math.max(
    Number.isFinite(periodMs) && (periodMs as number) > 0 ? (periodMs as number) : 0,
    QUERY_BAN_CODES.has(codeLc) ? QUERY_BAN_MIN_WAIT_MS : 0,
  );
  const snippet = s.slice(0, 160).replace(/\s+/g, ' ').trim();
  return { code: code || undefined, status, reqId: reqId || undefined, minWaitMs: minWaitMs || undefined, retryable: !DETERMINISTIC_CODES.has(codeLc), snippet };
}

/** The explicit failure web_pipe returns instead of a digest: names the
 *  provider error code / HTTP status / req_id (throttle vs query-block) and
 *  states plainly that nothing was ingested. */
export function serpBackendFailedSummary(e: SerpProviderError): string {
  const ids: string[] = [];
  if (e.code) ids.push(`x-brd-error-code=${e.code}`);
  if (e.status) ids.push(`HTTP ${e.status}`);
  if (e.reqId) ids.push(`req_id=${e.reqId}`);
  const idLine = ids.length ? ` BrightData: ${ids.join(', ')}.` : '';
  const waitLine = e.minWaitMs ? ` The provider states a ${Math.round(e.minWaitMs / 1000)} s minimum before a retry can succeed.` : '';
  const guidance = (e.code || '').toLowerCase() === 'unexpected_q'
    ? 'Query mismatch/block (unexpected_q) — rephrase the query; retrying the identical query fails the same way.'
    : 'Rate-limit / auto-throttle class — retry after backing off (the provider documents a 15 s minimum for query-level bans), rephrase the query, or call search_engine directly.';
  return `web_pipe search backend failed (SERP error) — the search provider answered with an error page instead of results, so no sources were ingested (the provider's own docs/error text was not scraped or stored).${idLine}${waitLine} ${guidance}`;
}
