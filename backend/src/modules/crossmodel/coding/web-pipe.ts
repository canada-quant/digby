/**
 * web_pipe — the DETERMINISTIC web ingestion pipeline (owner design, 2026-07-15).
 *
 * The agentic ingestor works, but every search→scrape step is a model turn
 * (latency + tokens). This tool runs the MECHANICS as a harness pipeline with
 * exactly ONE model call at the end:
 *
 *   search (if no urls given) → pick top links
 *     → scrape ×N in parallel (callMcpTool: direct BrightData first, gateway fallback)
 *       → chunk + embed into session RAG (storeFindings — same store
 *         search_memory reads)
 *         → ONE Qwen 3.6 27B call: summary + per-source index + suggested
 *           search_memory queries ("RAG directions")
 *
 * The orchestrator calls web_pipe once and gets back a digest + retrieval map;
 * detail stays in RAG instead of bloating the context window. Reasoning decides
 * WHEN to ingest; determinism does the WORK — same doctrine as the harness SERP
 * injection and the L2 pre-step.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { callMcpTool, extractPdfTextFromUrl } from '../mcp-search';
// Web-search not-configured signal (ticket 6f4d42f2): pure import-free leaf —
// safe under the partial-mock rule above (search-config-state imports nothing,
// so a jest.mock of ../mcp-search or ../platform/... never breaks it).
import { SEARCH_NOT_CONFIGURED_MSG, lastSearchConfigState } from '../platform/search-config-state';
import { unwrapSerpLinks } from '../serp-redirects';
import { isProviderSourceUrl, serpProviderErrorDetail, serpBackendFailedSummary, serpCarriesOrganic, type SerpProviderError } from '../serp-provider-guard';
import { storeFindings } from './coding-retrieval.service';
import { runHelperSeatCompletion } from './helper-seat';
import { answerKeyGuardEnabled, answerKeyDenyMatch, answerKeyCanaryMatch, answerKeyBlockedMessage, type AnswerKeyBlock } from './answer-key-guard';
// Pure leaf (not ../mcp-search, which test suites mock with a partial factory): is a
// search backend configured on this instance at all? Read only AFTER a null result.
import { webSearchStatus, WEB_PIPE_UNCONFIGURED_NOTE, webSearchProblemSuffix } from '../platform/instance-setup';

const MAX_SOURCES = 4;

// SERP provider-error retry (ticket 9b944f30): when the search backend
// answers with its own error body (429 sr_rate_limit auto-throttle / 502 with
// x-brd-error-code), ONE bounded backoff retry per web_pipe call before
// failing loudly. The provider documents a 15 s minimum for query-level bans
// (failed_query_rejected / repeat_query_rejected) — the pipe cannot honor
// that in-band (the caller's turn would stall 15 s), so the retry targets
// only the transient classes (rate/limit/challenge) and the failure text
// names the backoff guidance. unexpected_q is deterministic (query mismatch —
// the identical query fails identically) and is NOT retried.
const SERP_ERR_RETRY_MS = 3_000;
/** WEB_PIPE_SERP_RETRY_MS overrides the one in-band SERP-error retry wait (ms). */
function serpErrRetryMs(): number {
  const n = Number(process.env.WEB_PIPE_SERP_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SERP_ERR_RETRY_MS;
}


const SCRAPE_TIMEOUT_MS = 45_000;
const SUMMARY_MODEL = 'qwen3.6-27b' as const;
/** Below this a scrape counts as unreadable (error page / cookie wall / nothing). */
const MIN_GOOD_CHARS = 200;
// Same-host politeness (ticket e72d9def): parallel ACROSS hostnames, SERIAL
// within one. Base gap between same-host scrapes, doubled (to the cap) after
// each thin/failed same-host scrape, reset on a good one; jitter spreads the
// timing so bursts don't look robotic. Inject 0 via opts to skip sleeping.
const SAME_HOST_GAP_MS = 1500;
const SAME_HOST_GAP_CAP_MS = 6000;
const SAME_HOST_JITTER_MS = 700;
// Direct-fetch fallback (ticket 41631647): the one-shot scrape marks trivially
// fetchable text sources (raw.githubusercontent.com YAML, api.github.com JSON)
// "unreadable", so text-like URLs get one bounded plain HTTPS fetch before we
// give up. Also the ONE alternate tried for JS-shell pages (some SPAs serve
// SSR to a plain fetch).
const DIRECT_FETCH_MAX_BYTES = 500_000;
const DIRECT_FETCH_TIMEOUT_MS = 10_000;

// ── Latency (2026-10-20 real-user audit, probe WPL1020: web_pipe p50 69 s / p90 120 s over 34 prod calls in 12 h) ──
// STRAGGLER CUT: the pipe waited for the SLOWEST of its 4 scrapes, and a scrape whose direct AND gateway tiers both time
// out runs ~133 s (web_fetch_path scrape_as_markdown|none|empty:timeout, 42 rows / 12 h). Search-derived sources are
// interchangeable, so once EARLY_EXIT_MIN_GOOD of them read SUBSTANTIVELY (≥ EARLY_EXIT_COUNT_MIN_CHARS, not an
// unfetchable guidance body, not a benchmark canary), the pipe waits at least STRAGGLER_GRACE_MS more and then cuts
// only when every still-running scrape has been IN FLIGHT long enough to be a straggler — STRAGGLER_MIN_INFLIGHT_MS, or
// PROTECTED_MIN_INFLIGHT_MS for the top search result and PDFs (slower by nature, often the primary source); a site's
// queue sleeping its politeness gap blocks the cut (its next page is about to start). Explicitly GIVEN urls are never
// cut — the caller chose each one. A cut straggler is reported (STRAGGLER_NOTE / NOT_STARTED_NOTE), never stored or
// digested; its in-flight call runs to its own timeout, its result ignored. WEB_PIPE_EARLY_EXIT_DISABLED=1 waits for
// every scrape again.
const EARLY_EXIT_MIN_GOOD = 2;
const EARLY_EXIT_COUNT_MIN_CHARS = 1_500;
const STRAGGLER_GRACE_MS = 8_000;
const STRAGGLER_MIN_INFLIGHT_MS = 25_000;
// A latency choice (one scrape-timeout's worth), not a PDF bound: a scanned PDF still in OCR can run longer and is cut.
const PROTECTED_MIN_INFLIGHT_MS = SCRAPE_TIMEOUT_MS;
const CUT_POLL_MS = 250;
export const STRAGGLER_NOTE = 'skipped — still loading after the other sources were read (web_pipe straggler cut)';
export const NOT_STARTED_NOTE = 'not read — queued behind a slow page on the same site when the other sources were already in (web_pipe straggler cut)';
export function webPipeEarlyExitDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_PIPE_EARLY_EXIT_DISABLED === '1';
}
/** A PDF-looking URL (local check — the mcp-search helpers are partial-mocked in every suite): a .pdf path, or a path
 *  segment named pdf (arXiv's canonical /pdf/<id> links carry no extension). Pure. */
function looksLikePdfUrl(url: string): boolean {
  try { const p = new URL(url).pathname; return /\.pdf$/i.test(p) || /(^|\/)pdf(\/|$)/i.test(p); } catch { return false; }
}
// UNPARSEABLE-SERP RETRY: 5 of 34 calls (15 %) answered "no parseable organic links" after a 51 s median while a
// search_engine call the model made on the same turn moments later returned normal results — the model then spent a
// turn re-searching and narrated a "throttled" search. One bounded retry inside the pipe instead.
// The retry is bounded at SERP_EMPTY_RETRY_TIMEOUT_MS of WALL-CLOCK time (the callMcpTool timeout is per tier attempt).
// WEB_PIPE_SERP_EMPTY_RETRY_DISABLED=1 restores the immediate zero-source answer.
const SERP_EMPTY_RETRY_TIMEOUT_MS = 30_000;
// D3 resume-after-throttle budget for the pipe's OWN search call (goal
// 9ecd595e, 2026-10-31). web_pipe is the long-budget research path — the run
// that produced the Polk defect — so unlike an interactive single lookup it can
// afford to WAIT OUT a stated rate-limit ban rather than answer "search
// failed". The provider's stated wait is honoured up to this budget; a wait
// beyond it still fails fast, exactly as before. Absent this opt-in the
// ca805a61 fail-fast contract is unchanged for every other caller.
//
// SIZED TO THE CANONICAL THROTTLE (WRP-1 D3-R, 2026-11-03): BrightData's own
// auto-throttle body states `x-brd-rate-limit-period-ms: 60000`. At the old
// 45 s budget the canonical shape was arithmetically OUTSIDE the ladder
// (`resumeWorthIt = Date.now() + 60000 <= resumeDeadline` was false on entry),
// so it took the fail-fast return and no `web_serp_resume` row could EVER be
// emitted for it — the defect was in this budget, not in the 8 s
// SERP_PROVIDER_RETRY_WAIT_CAP_MS. The cap still governs the DEFAULT branch
// (an interactive caller passes no budget and still fails fast at once); this
// constant only decides how long the RESEARCH path will wait. 70 s = the 60 s
// canonical period plus margin for the direct-tier attempt + gateway entry
// before `resumeDeadline` is stamped, so a 60 s-stated throttle resumes and a
// second one inside the same call cannot (the deadline is fixed once, at
// entry).
export const WEB_PIPE_SERP_RESUME_BUDGET_MS = 70_000;
export function webPipeSerpEmptyRetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_PIPE_SERP_EMPTY_RETRY_DISABLED === '1';
}

// FAST DIGEST (2026-10-20, probe WPT1020 after the straggler cut: 19 prod calls — search p50 11 s, scrape 17 s, store
// 4 s, DIGEST p50 47 s / p90 + max 60 s = the summarize timeout, i.e. ≥ 10 % fell back to the bare source index). The
// Helper seat writes ~30 tok/s, so the 1,400-token budget WAS the latency. The digest now targets DIGEST_WORD_TARGET
// words under FAST_DIGEST_MAX_TOKENS (detail stays in session RAG for search_memory), and the session-RAG store runs
// IN PARALLEL with it — the RAG-query hints ride a final RAG_QUERIES_MARKER section that is stripped when the store
// landed nothing (the 2026-09-04 honesty rule: never promise search_memory content that never landed).
// WEB_PIPE_FAST_DIGEST_DISABLED=1 restores the sequential store + the 1,400-token digest.
const FAST_DIGEST_MAX_TOKENS = 800;
const DIGEST_WORD_TARGET = 300;
export const RAG_QUERIES_MARKER = 'SEARCH_MEMORY QUERIES:';
export function webPipeFastDigestDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_PIPE_FAST_DIGEST_DISABLED === '1';
}
// The marker as a LINE START (the last such line counts), matched on the original string — never an uppercased index
// (ß → SS drifts it). The prefix is a bounded run of list / heading / bold / quote / numbering markup ("**3. ",
// "### 3. ", "> ", "3) \"") plus an optional "Suggested"; the phrase tolerates "_" / escaped "\_" / a space between
// its words, backticks, and a trailing "for retrieving …" before the colon (the prompt's own wording). A body line
// that merely mentions search-memory queries ("Use search_memory queries sparingly") has a non-markup prefix or no
// colon and is kept. Every quantifier is bounded (no backtracking blow-up on long whitespace / markup lines).
const RAG_QUERIES_LINE_RE = /^(?:[^\S\n]|[-*+>#_`"'“”‘’.)(\[\]\d•]|suggested\b){0,24}`?search(?:\\?_|[^\S\n])`?memory`?(?:\\?_|[^\S\n])queries\b(?:[^\S\n]+(?:for|to)\b[^\n:：]{0,80})?[*_`"'“”’)\]]{0,6}[^\S\n]{0,3}(?:[:：]|-[^\S\n]*$|$)/gim;
/** Drop the digest's RAG-query section (from its marker line on). Pure. */
export function stripRagQueries(summary: string): string {
  let cut = -1;
  for (const m of summary.matchAll(RAG_QUERIES_LINE_RE)) cut = m.index ?? cut;
  return cut < 0 ? summary : summary.slice(0, cut).trimEnd();
}

/** Per-call stage timings, returned on the result (the tool executor records one loop_metrics web_pipe_timing row per
 *  call — this module stays free of the loop-metrics import chain, like the mcp-search partial-mock rule above). */
export interface WebPipeTiming {
  t0: number;
  mode: 'query' | 'urls' | 'none';
  searchMs?: number;
  serpRetry?: 'retried_ok' | 'retried_empty' | 'retried_provider_error';
  retryMs?: number;
  serpShape?: { chars: number; json: boolean; organicKey: boolean };
  scrapeMs?: number;
  targets?: number;
  good?: number;
  stragglers?: number;
  notStarted?: number;
  storeMs?: number;
  digestMs?: number;
  digestChars?: number;
  fastDigest?: boolean;
}

/** The timing row's meta (t0 dropped, totalMs added). Pure. */
export function webPipeTimingMeta(timing: WebPipeTiming, ok: boolean): Record<string, unknown> & { totalMs: number } {
  const { t0, ...rest } = timing;
  return { ...rest, totalMs: Date.now() - t0, ok };
}

/** Targets from one SERP text: organic[] (JSON) or the raw-URL fallback, the provider-host filter on the latter. */
function serpTargets(serpText: string): { targets: Array<{ url: string; title?: string }>; nonJson: boolean; providerOnly: boolean } {
  let targets = topLinks(serpText, MAX_SOURCES);
  if (serpCarriesOrganic(serpText)) return { targets, nonJson: false, providerOnly: false };
  const before = targets.length;
  targets = targets.filter(t => !isProviderSourceUrl(t.url));
  if (before > targets.length) {
    logger.warn(`web_pipe: dropped ${before - targets.length} search-derived source(s) on the search provider's own host (ticket 9b944f30) — provider docs/error pages are never ingested as sources`);
  }
  return { targets, nonJson: true, providerOnly: !targets.length && before > 0 };
}

/** The shape of a SERP that parsed to nothing — counts + booleans only (never its text) for the timing row. */
function serpShapeOf(serpText: string): { chars: number; json: boolean; organicKey: boolean } {
  let json = false;
  try { JSON.parse(serpText); json = true; } catch { /* not JSON */ }
  return { chars: serpText.length, json, organicKey: /"organic"\s*:/.test(serpText) };
}

export interface WebPipeResult {
  ok: boolean;
  summary: string;
  sources: Array<{ url: string; title?: string; chars: number; stored: boolean; note?: string; status?: number }>;
  storedChunks: number;
  /** The model spec that ACTUALLY wrote the digest — the coding_helper seat,
   *  or the built-in helper when the custom seat failed and the health
   *  fallback served (absent when the index-only fallback was returned) —
   *  attribution for the tool trailer. */
  model?: string;
  /** Stage timings + counts (webPipeTimingMeta) — the caller records them as loop_metrics web_pipe_timing. */
  timing?: Record<string, unknown> & { totalMs: number };
}

/** One scraped target, pre-digest (text is dropped from the public result). */
interface ScrapedSource {
  url: string;
  title?: string;
  text: string;
  chars: number;
  note?: string;
  status?: number;
}

// Hosts that serve verbatim text (no JS, no anti-bot) — always worth a direct fetch.
const TEXT_LIKE_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com', 'gist.githubusercontent.com']);
const TEXT_LIKE_EXT_RE = /\.(ya?ml|json|md|txt|toml|csv)$/i;

/** URL is a known raw-text host or carries a plain-text file extension. */
export function isTextLikeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return TEXT_LIKE_HOSTS.has(u.hostname.toLowerCase()) || TEXT_LIKE_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// JS-shell heuristic (ticket 7f236c00): a pre-render SPA shell ("Loading..."
// placeholder, "enable JavaScript" notice, empty root div) is SHORT and content-
// free — storing it as a good scrape poisons the digest with confident nothing.
const JS_SHELL_MAX_CHARS = 6000;
const JS_SHELL_MARKERS = [
  /you need to enable javascript/i,
  /enable javascript to (run|view|use|continue)/i,
  /<div[^>]*\bid=["'](root|app|__next)["'][^>]*>\s*<\/div>/i, // empty SPA mount point
  /\bloading\b\s*(\.{3}|…)/i,                                 // "Loading..." placeholder
  /^[\s#*_>-]*loading[\s.…]*$/im,                             // a line that is ONLY "Loading"
];
export const JS_SHELL_NOTE = 'JS-rendered page — content unavailable';

/** Short body + an SPA-shell marker → the scrape got the pre-JS shell, not content. */
export function looksLikeJsShell(text: string): boolean {
  if (!text || text.length > JS_SHELL_MAX_CHARS) return false;
  return JS_SHELL_MARKERS.some(re => re.test(text));
}

// ── Provider-independent HTML fallback (2026-11-05, digby.cql.ca web_pipe report) ──────────
// THE DEFECT: `scrapeOne` only ever escalated to a direct fetch on TWO shapes — a
// text-like URL (raw .yaml/.json/.md, ticket 41631647) or a JS-shell page (ticket
// 7f236c00). An ORDINARY HTML page whose provider scrape came back null/thin
// therefore got no alternate at all, so when the scrape tier was degraded (a
// self-hosted Edge with a store-only Bright Data key, a gateway hiccup, a host
// Bright Data refuses by policy) EVERY normal page read as "no usable content" —
// `web_pipe({urls:['https://example.com/']})` failed while `scrape_as_markdown`
// on the same URL succeeded. This block closes that: ONE bounded plain-HTTPS
// fetch, converted to TEXT (raw markup is never stored or digested).
//
// Bounds and refusals, all deliberate (this is a network call we did not need
// before, so it must be narrower than the scrape it stands in for):
//   - public http(s) hosts only — no loopback/private/.local/.internal name, no
//     IP literal, no credentials in the URL, ports 80/443 only, and the same
//     guard is re-applied to every redirect hop (max 3);
//   - no auth, no cookies: a plain Accept header only (a page behind a login
//     must stay unreadable, never harvested);
//   - bounded time (DIRECT_FETCH_TIMEOUT_MS) and size (DIRECT_FETCH_MAX_BYTES);
//   - an HTTP error status, a bot-challenge/interstitial page, or a non-HTML
//     content type is NOT converted into "content" — it stays an honest note;
//   - ONE attempt per URL, only after the provider scrape already failed, so no
//     retry storm and no extra load on a host that just blocked us;
//   - WEB_PIPE_HTML_DIRECT_FALLBACK_DISABLED=1 restores the previous behaviour
//     (text-like + JS-shell alternates only) from box env with no deploy.
export function webPipeHtmlDirectFallbackDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEB_PIPE_HTML_DIRECT_FALLBACK_DISABLED === '1';
}

/** Note on a source read through the HTML fallback — says HOW it was read, so an
 *  operator never mistakes it for a provider scrape and a model never presents
 *  it as the same evidence class. */
export const HTML_DIRECT_NOTE = 'read via direct fetch — provider scrape returned nothing, page HTML converted to text';

/** Note when the direct fetch got a bot challenge / block interstitial instead of content. */
export const HTML_CHALLENGE_NOTE = 'blocked — the host answered the direct fetch with a bot-challenge/interstitial page (no content read; nothing to bypass)';

const MAX_REDIRECTS = 3;
const HTML_CONTENT_TYPE_RE = /^\s*(?:text\/html|application\/xhtml\+xml)/i;
const HTML_DOC_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;
// A challenge/interstitial is SHORT by construction. Gating on length keeps a
// real article ABOUT captchas (long, has the word) from being misread as one.
const CHALLENGE_MAX_CHARS = 8_000;
const CHALLENGE_HTML_RE = /(?:cf-browser-verification|cf-challenge|challenge-platform|g-recaptcha|hcaptcha|captcha-delivery|are you a robot|unusual traffic|verify you are (?:a )?human|checking your browser|attention required|access denied|too many requests|rate limit exceeded|request (?:was )?blocked|enable (?:javascript|) ?cookies)/i;
const HTML_TEXT_MAX_CHARS = 200_000;

/** Why a plain direct fetch must NOT be made to this URL, or null when it is a
 *  public http(s) target. Pure. Mirrors the policy the scrape tier refuses on
 *  (brightdata-direct classifyUnfetchableTarget) so a host the provider will not
 *  serve is not silently fetched by us either — but WITHOUT that module's
 *  provider-refusal memo, which records Bright Data's own policy decisions. */
export function directFetchBlockedReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid absolute URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported scheme ${u.protocol}`;
  if (u.username || u.password) return 'URL carries credentials';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'no host';
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return `private hostname ${host}`;
  // Every IP literal is refused — a hostname the provider can resolve is the only
  // shape a cloud fetcher should reach (this also covers 127/8, 10/8, 192.168/16,
  // 172.16/12, 169.254/16 link-local, ::1 and IPv6 literals).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return `IP-literal host ${host}`;
  if (u.port && u.port !== '80' && u.port !== '443') return `non-standard port ${u.port}`;
  return null;
}

/** Decode the entity set that shows up in real page text. Bounded: a numeric
 *  entity is only decoded in the Unicode scalar range, so a hostile `&#99999999;`
 *  is left alone rather than throwing. Pure. */
function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  };
  return s
    .replace(/&#(\d{1,7});/g, (_m, d: string) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-z]{2,8});/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

/** A residual markup SHAPE — a tag with a letter-led name, or an HTML comment.
 *  Deliberately narrow: a bare `<` in prose ("5 < 3", "a < b") has no letter
 *  immediately after the `<` or `/`, so it never matches. */
const RESIDUAL_COMMENT_RE = /<!--[\s\S]*?-->/g;
const RESIDUAL_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>/g;

/** Convert an HTML document to readable TEXT — script/style/noscript/svg/
 *  iframe/template bodies and every tag are dropped, block boundaries become
 *  newlines, entities are decoded, whitespace is collapsed. The result is what
 *  the pipe stores in session RAG and feeds the digest; raw markup NEVER
 *  survives this function's output. Pure + exported for unit tests. */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.slice(0, DIRECT_FETCH_MAX_BYTES);
  s = s.replace(RESIDUAL_COMMENT_RE, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object|canvas|form|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // An UNCLOSED script/style (truncated body) would otherwise leak its source into the text.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, ' ');
  s = s.replace(/<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|tr|td|th|table|thead|tbody|blockquote|pre|hr|br|figure|figcaption|dl|dt|dd|title|body|html)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeHtmlEntities(s);
  // SECOND strip pass — the one that makes "no raw markup" actually TRUE.
  // Decoding runs after the first strip, so markup that the SOURCE carried
  // entity-escaped (`&lt;!-- … --&gt;`, `&lt;ref&gt;` — routine in Wikipedia
  // template/lua source shown as text, and in any page documenting HTML)
  // re-materialises as literal markup in the decoded string. Found by running
  // the extractor on two real pages it was never tuned on (IANA 6.7 KB and
  // Wikipedia 119 KB): 10 markup-shaped strings survived. Stripping again after
  // decode is what closes it; a single pre-decode pass cannot, by construction.
  // Trade-off, accepted deliberately: prose containing a tag-shaped run
  // ("x <y and y> z") loses that fragment. Losing a rare fragment is strictly
  // better than storing markup, which the pipe's contract forbids.
  s = s.replace(RESIDUAL_COMMENT_RE, ' ').replace(RESIDUAL_TAG_RE, ' ');
  s = s
    .replace(/[ \t\f\v\u00a0\u200b]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.slice(0, HTML_TEXT_MAX_CHARS);
}

/** Does this response body look like an HTML document? Content type wins when it
 *  names one; otherwise the first bytes decide (many hosts mislabel or omit it).
 *  A JSON/text body is never treated as HTML. Pure. */
export function looksLikeHtmlBody(body: string, contentType?: string): boolean {
  const ct = (contentType || '').trim();
  if (ct) {
    if (HTML_CONTENT_TYPE_RE.test(ct)) return true;
    // An explicitly non-text type (json/xml/plain/pdf/binary) is NOT html.
    if (/^text\/|json|xml|javascript|csv/i.test(ct)) return false;
  }
  return HTML_DOC_RE.test(body.slice(0, 512));
}

interface DirectFetchResult { body: string; status?: number; contentType?: string }

/** ONE bounded plain-HTTP GET. Public targets only (directFetchBlockedReason,
 *  re-applied to every redirect hop); no auth, no cookies. Returns null on
 *  failure, an HTTP error status, or an empty/PDF body. `diag` (optional
 *  out-param, ticket e72d9def) records the status for per-URL classification. */
async function directFetchRaw(url: string, diag?: { status?: number }): Promise<DirectFetchResult | null> {
  const blocked = directFetchBlockedReason(url);
  if (blocked) {
    logger.info(`web_pipe: direct fetch refused for "${url.slice(0, 60)}" — ${blocked}`);
    return null;
  }
  try {
    const r = await axios.get(url, {
      timeout: DIRECT_FETCH_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(d: any) => d],
      maxContentLength: DIRECT_FETCH_MAX_BYTES,
      maxBodyLength: DIRECT_FETCH_MAX_BYTES,
      maxRedirects: MAX_REDIRECTS,
      // Every hop is held to the same public-target rule: a redirect to
      // localhost/RFC1918/an IP literal is refused rather than followed.
      beforeRedirect: (opts: any) => {
        const next = typeof opts?.href === 'string'
          ? opts.href
          : `${opts?.protocol || 'https:'}//${opts?.hostname || ''}${opts?.path || ''}`;
        const why = directFetchBlockedReason(next);
        if (why) throw new Error(`blocked redirect to a non-public target (${why})`);
      },
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml, application/json;q=0.8, */*;q=0.5' },
    });
    if (diag) diag.status = r.status;
    // Never convert an error page into content — that is how a 403 wall becomes
    // a "source". (axios only rejects on 4xx/5xx; this is the validateStatus seam.)
    if (typeof r.status === 'number' && r.status >= 400) return null;
    const body = (typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '')) || '';
    if (!body.trim() || body.trimStart().startsWith('%PDF-')) return null;
    return { body, status: r.status, contentType: String(r.headers?.['content-type'] || '') };
  } catch (err: any) {
    if (diag) diag.status = err?.response?.status;
    logger.info(`web_pipe: direct fetch failed for "${url.slice(0, 60)}" (${err?.message || err})`);
    return null;
  }
}

/** The outcome of ONE bounded plain-HTTP read, as TEXT — never raw markup. */
type DirectRead =
  | { kind: 'text'; text: string; html: boolean }
  | { kind: 'blocked' }  // a bot-challenge / interstitial: the host refused
  | { kind: 'none' };    // failed / empty / PDF / non-public target

/** ONE bounded plain-HTTP read converted to TEXT. An HTML body goes through
 *  htmlToText (so raw markup is never stored or digested); a challenge or an
 *  interstitial is reported as `blocked`, never converted into content. */
async function directFetchReadableText(url: string, diag?: { status?: number }): Promise<DirectRead> {
  const r = await directFetchRaw(url, diag);
  if (!r) return { kind: 'none' };
  if (!looksLikeHtmlBody(r.body, r.contentType)) {
    const body = r.body.trim();
    return body ? { kind: 'text', text: body.slice(0, DIRECT_FETCH_MAX_BYTES), html: false } : { kind: 'none' };
  }
  // An explicit challenge / interstitial is a REFUSAL, not content: the host said
  // no. There is nothing to bypass and nothing to store.
  const head = r.body.slice(0, CHALLENGE_MAX_CHARS);
  if (head.length <= CHALLENGE_MAX_CHARS && CHALLENGE_HTML_RE.test(head)) {
    logger.info(`web_pipe: direct fetch got a challenge/interstitial page for "${url.slice(0, 60)}" — reporting blocked`);
    return { kind: 'blocked' };
  }
  const text = htmlToText(r.body);
  if (!text) return { kind: 'none' };
  logger.info(`web_pipe: direct fetch read "${url.slice(0, 60)}" as HTML → ${text.length} chars of text from ${r.body.length} bytes`);
  return { kind: 'text', text, html: true };
}

/** The raw-text shape used by the text-like and JS-shell alternates: the body as
 *  text. An HTML document is converted to text here too (the SSR-body alternate
 *  used to store raw markup); a challenge or a non-public target yields null. */
async function directFetchText(url: string, diag?: { status?: number }): Promise<string | null> {
  const r = await directFetchReadableText(url, diag);
  if (r.kind !== 'text') return null;
  logger.info(`web_pipe: direct fetch fallback ok for "${url.slice(0, 60)}" (${r.text.length} chars)`);
  return r.text;
}

/** Extract top organic links from the SERP JSON text search_engine returns.
 *  Pure + exported for unit tests (same idiom as nextSameHostGap). */
export function topLinks(serpText: string, n: number): Array<{ url: string; title?: string }> {
  try {
    const parsed = JSON.parse(serpText);
    const organic: any[] = Array.isArray(parsed?.organic) ? parsed.organic : [];
    // Dedup by URL BEFORE slicing (feedback ba968a07 — parity with the regex
    // fallback below): SERPs repeat links (sitelinks, video/news echoes of the
    // same page), and undeduped dupes burned MAX_SOURCES slots re-scraping and
    // re-embedding the same page — pure context flooding with zero new info.
    const seen = new Set<string>();
    const out: Array<{ url: string; title?: string }> = [];
    for (const o of organic) {
      // Check-before-push (review nit, PR #471): keeps n<=0 semantics
      // identical to the old slice(0,n) — same idiom as youtubeLinksFromSerp.
      if (out.length >= n) break;
      if (typeof o?.link !== 'string' || !/^https?:\/\//.test(o.link)) continue;
      if (seen.has(o.link)) continue;
      seen.add(o.link);
      out.push({ url: o.link, title: o.title });
    }
    return out;
  } catch {
    // Non-JSON SERP (rare) — fall back to raw URL extraction.
    const urls = serpText.match(/https?:\/\/[^\s"'\\)\]}>]+/g) || [];
    return [...new Set(urls)].slice(0, n).map(u => ({ url: u }));
  }
}

/** Keep the first occurrence of each URL (post-unwrap dedup — two SERP wrappers
 *  can resolve to the same page). Order preserved. */
function dedupeTargetsByUrl<T extends { url: string }>(targets: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of targets) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    out.push(t);
  }
  return out;
}

/** One non-streaming summarizer call — the pipe's single model invocation.
 *  Runs the instance's coding_helper SEAT (model-roles config; default Qwen),
 *  so an Edge box without DashScope keys can point it at a custom endpoint.
 *  Reasoning-shaped built-ins are rejected for this seat at save time
 *  (model-roles NON_STREAMING_ROLES). The call goes through helper-seat.ts →
 *  helper-completion.ts (thinking-off directive for custom endpoints, closed +
 *  UNCLOSED <think> stripping, and an EMPTY answer THROWS so the index-only
 *  fallback below fires instead of a blank digest — owner report 2026-09-08),
 *  plus the seat HEALTH fallback (owner 2026-09-14): a custom seat that 4xx's,
 *  times out, is unreachable or answers empty is retried ONCE on the built-in
 *  helper, and the digest carries an honest attribution line. Returns the
 *  digest AND the spec that actually produced it (attribution). */
async function qwenSummarize(prompt: string, timeoutMs = 60_000, sessionId?: string | null, maxTokens = 1400): Promise<{ text: string; model: string; attribution?: string }> {
  const r = await runHelperSeatCompletion({
    messages: [{ role: 'user', content: prompt }],
    maxTokens, temperature: 0.3, timeoutMs,
    caller: 'web_pipe', builtIn: SUMMARY_MODEL, sessionId: sessionId ?? undefined,
  });
  logger.info(`web_pipe: digest via ${r.model} (${r.label})${r.fallback ? ` — helper seat fallback from ${r.fallback.from}: ${r.fallback.reason}` : ''}`);
  return { text: r.text, model: r.model, attribution: r.attribution };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Next same-host gap after a scrape (ticket e72d9def): double (to the cap)
 *  on a thin/failed scrape — the host is signalling — reset to base on a good
 *  one. Pure + exported so the backoff policy is unit-testable without timers. */
export function nextSameHostGap(currentGapMs: number, scrapedChars: number, baseGapMs: number): number {
  return scrapedChars <= MIN_GOOD_CHARS ? Math.min(currentGapMs * 2, SAME_HOST_GAP_CAP_MS) : baseGapMs;
}

/** Scrape ONE target: MCP scrape → PDF extraction → raw-text direct-fetch
 *  fallback → JS-shell detection → per-URL failure classification. */
async function scrapeOne(t: { url: string; title?: string }): Promise<ScrapedSource> {
  const diag: { status?: number } = {};
  const md = await callMcpTool('scrape_as_markdown', { url: t.url }, SCRAPE_TIMEOUT_MS).catch(() => null);
  let text = typeof md === 'string' ? md : '';
  let note: string | undefined;
  let triedDirect = false;

  // PDF bytes (ticket bf4e0629): callMcpTool extracts PDFs itself, but a raw
  // %PDF- body can still slip through (gateway tier) — extract, never store binary.
  if (text.trimStart().startsWith('%PDF-')) {
    text = (await extractPdfTextFromUrl(t.url).catch(() => null)) || '';
    if (!text) note = 'PDF — text extraction failed';
  }

  // Raw-text fallback (ticket 41631647): text-like URLs are trivially fetchable —
  // use the verbatim body instead of marking them unreadable.
  if (text.length <= MIN_GOOD_CHARS && isTextLikeUrl(t.url)) {
    triedDirect = true;
    const direct = await directFetchText(t.url, diag);
    if (direct) {
      text = direct;
      note = undefined;
    }
  }

  // JS-shell detection (ticket 7f236c00): don't pass a "Loading..." shell off as
  // content. ONE alternate — the direct fetch (some SPAs serve SSR to plain
  // fetch) — else report the page honestly unavailable.
  if (text && looksLikeJsShell(text)) {
    if (!triedDirect) {
      triedDirect = true;
      const direct = await directFetchText(t.url, diag);
      if (direct && direct.length > MIN_GOOD_CHARS && !looksLikeJsShell(direct)) {
        text = direct;
      } else {
        text = '';
        note = JS_SHELL_NOTE;
      }
    } else {
      text = '';
      note = JS_SHELL_NOTE;
    }
  }

  // ── Provider-independent HTML fallback (2026-11-05) ─────────────────────────
  // THE GAP THIS CLOSES: the two alternates above fire only on a TEXT-LIKE url or
  // a JS-shell body. An ORDINARY HTML page whose provider scrape came back
  // null/thin (a degraded scrape tier, a store-only Edge key, a host the provider
  // refuses by policy) therefore had NO alternate and read as "no usable
  // content" — `web_pipe({urls:['https://example.com/']})` failed on a page
  // `scrape_as_markdown` reads fine. ONE bounded direct read, HTML converted to
  // TEXT (htmlToText — raw markup is never stored or digested), guarded by
  // directFetchBlockedReason + the redirect re-check + the challenge refusal.
  // `triedDirect` keeps it to at most ONE direct attempt per URL (no storm), and
  // a host that answered with a challenge/interstitial is reported as BLOCKED,
  // never converted into content.
  if (!note && !triedDirect && text.length <= MIN_GOOD_CHARS && !webPipeHtmlDirectFallbackDisabled()) {
    triedDirect = true;
    const read = await directFetchReadableText(t.url, diag);
    if (read.kind === 'text' && read.text.length > text.length) {
      text = read.text;
      // Attribution, not a warning — and ONLY when the read actually cleared the
      // same usability floor every other source is held to. A page whose full
      // text is thinner than MIN_GOOD_CHARS (the real https://example.com/ is
      // 172 chars of boilerplate) is NOT a success: claiming "read via direct
      // fetch" there while the pipe still counts the source unreadable is the
      // same class of dishonesty as calling a 403 wall content. Leave the note
      // unset so the failure classification below reports it truthfully.
      note = read.html && read.text.length > MIN_GOOD_CHARS ? HTML_DIRECT_NOTE : undefined;
    } else if (read.kind === 'blocked' && !text.trim()) {
      note = HTML_CHALLENGE_NOTE;
    }
  }

  // Failure classification (ticket e72d9def): make per-URL block/rate-limit
  // visible. Existing PDF/JS-shell notes take precedence — never overwrite.
  const chars = text.length;
  if (chars <= MIN_GOOD_CHARS && !note) {
    // Only cite the HTTP status when it actually signals a block/limit — a
    // 2xx with a thin body is just a thin page, not a rate-limit.
    note = diag.status && diag.status >= 400
      ? `unreadable — direct fetch returned HTTP ${diag.status} (likely host block/rate-limit)`
      : 'unreadable — scrape returned no usable content (host block/rate-limit or empty page)';
  }

  return { ...t, text, chars, note, status: diag.status };
}

/**
 * sessionId null = no session RAG store available (legacy pipeline models call
 * the pipe via ToolCache): storage is skipped and the digest omits
 * search_memory hints, since those callers have no search_memory tool.
 */
type WebPipeOpts = {
  sameHostGapMs?: number; onAnswerKeyBlock?: (b: AnswerKeyBlock) => void; serpRetryMs?: number;
  stragglerGraceMs?: number; stragglerMinInflightMs?: number; protectedMinInflightMs?: number; serpEmptyRetryTimeoutMs?: number;
};

export async function runWebPipe(
  sessionId: string | null,
  args: { query?: string; urls?: string[]; focus?: string },
  onProgress?: (message: string) => void,
  /** onAnswerKeyBlock: the caller's answer_key_blocked metric sink (answer-key-guard.ts, opt-in ANSWER_KEY_GUARD=1).
   *  stragglerGraceMs / stragglerMinInflightMs / protectedMinInflightMs: tests drive the straggler cut's timings. */
  opts?: WebPipeOpts,
): Promise<WebPipeResult> {
  const hasUrls = Array.isArray(args.urls) && args.urls.some(u => typeof u === 'string' && /^https?:\/\//.test(u));
  const timing: WebPipeTiming = { t0: Date.now(), mode: hasUrls ? 'urls' : args.query ? 'query' : 'none' };
  const result = await runWebPipeInner(sessionId, args, timing, onProgress, opts);
  return { ...result, timing: webPipeTimingMeta(timing, result.ok) };
}

async function runWebPipeInner(
  sessionId: string | null,
  args: { query?: string; urls?: string[]; focus?: string },
  timing: WebPipeTiming,
  onProgress?: (message: string) => void,
  opts?: WebPipeOpts,
): Promise<WebPipeResult> {
  const akGuard = answerKeyGuardEnabled();
  const akReport = (b: AnswerKeyBlock) => { try { opts?.onAnswerKeyBlock?.(b); } catch { /* telemetry only */ } };
  // ── 1. Resolve sources (deterministic) ─────────────────────────────────────
  let targets: Array<{ url: string; title?: string }> = [];
  const givenUrls = (Array.isArray(args.urls) ? args.urls : [])
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
    .slice(0, MAX_SOURCES)
    .map(u => ({ url: u }));
  targets = givenUrls;

  // Zero-source cause honesty (ticket 8be329e8): a bare "found no sources"
  // made provider throttles indistinguishable from a genuinely unsearchable
  // topic — search_engine surfaces degradation via WEB_DEGRADED_MSG, web_pipe
  // swallowed it. Classify from LOCAL evidence (serp truthiness) only: this
  // module must not import webToolsDegraded, because every test suite mocks
  // ../mcp-search with a partial factory ({ callMcpTool, extractPdfTextFromUrl }).
  let zeroSourceNote: string | null = null;
  // Provenance (ticket 9b944f30 review): true when the targets came from a
  // NON-JSON SERP (the topLinks regex-fallback path) — the only path whose
  // extracted links are unvalidated enough to carry the provider's own
  // docs/error URLs, and the only path the provider-host filter applies to
  // (GIVEN urls are the caller's explicit choice; a JSON organic[] result set
  // is the provider's validated answer — a query ABOUT the provider keeps it).
  let nonJsonSearchSerp = false;
  if (!targets.length && args.query) {
    onProgress?.(`Searching — ${args.query.slice(0, 60)}`);
    // Tier-classified provider errors (ticket ca805a61): callMcpTool's gateway
    // tier + chokepoint now classify the provider's error/debug body as a
    // FAILED attempt (their own retry/backoff + circuit machinery) and null
    // the result — so the local classifier below can no longer see the body
    // through the real path. The onSerpProviderError callback hands the pipe
    // the classified detail so the 9b944f30 explicit failure (naming
    // x-brd-error-code, throttle vs query-block) is preserved, not regressed
    // to the generic zero-source note. Callers keep the FIRST detail (the
    // attempt-1 diagnosis; the callback may fire per failed attempt).
    let tierProviderError: SerpProviderError | null = null;
    const tierErr: { d: SerpProviderError | null } = { d: null };
    let serp = await callMcpTool('search_engine', { query: args.query.slice(0, 200), engine: 'google' }, undefined, {
      onSerpProviderError: (d) => { if (!tierErr.d) tierErr.d = d; },
      // D3 (goal 9ecd595e): this is the long-budget research path, so a stated
      // rate-limit ban is waited out here rather than surfaced as "search
      // failed". Bounded by the pipe's own budget — the interactive fail-fast
      // contract is untouched for every other caller.
      resumeBudgetMs: WEB_PIPE_SERP_RESUME_BUDGET_MS,
    }); // callMcpTool is direct-first (2026-07-15)
    timing.searchMs = Date.now() - timing.t0;
    tierProviderError = tierErr.d;
    if (!serp && tierProviderError) {
      // The tier already classified + failed the provider error (and either
      // burned its bounded retry budget honoring the stated wait, or correctly
      // fail-fasted the deterministic class) — no second in-band retry here.
      logger.warn(`web_pipe: search backend failed (SERP error, classified by the search tier) — no sources ingested${tierProviderError.code ? ` (x-brd-error-code=${tierProviderError.code})` : ''}${tierProviderError.status ? ` HTTP ${tierProviderError.status}` : ''}${tierProviderError.reqId ? ` req_id=${tierProviderError.reqId}` : ''}: ${tierProviderError.snippet}`);
      return { ok: false, summary: serpBackendFailedSummary(tierProviderError), sources: [], storedChunks: 0 };
    }
    if (!serp && !tierProviderError) {
      // Ticket 6f4d42f2: an instance with NO search credentials anywhere (no
      // env BRIGHTDATA_API_TOKEN, no admin-store key, no gateway token) must
      // say SO — callMcpTool's pre-flight recorded the resolution outcome on
      // the pure config-state leaf; the generic zero-source note below told
      // the owner's self-hosted chat "gateway unreachable" with no actionable
      // message. Render the operator-facing diagnosis.
      const cfg = lastSearchConfigState();
      if (cfg && !cfg.anyBackendArmed) {
        logger.warn('web_pipe: search not configured on this instance (no env key, no admin-store key, no gateway token) — failing fast with the operator-facing message (ticket 6f4d42f2)');
        return { ok: false, summary: SEARCH_NOT_CONFIGURED_MSG, sources: [], storedChunks: 0 };
      }
    }
    // SERP provider-error guard (ticket 9b944f30): BrightData's gateway tier
    // intermittently wraps a provider failure (429 sr_rate_limit / 502 with
    // x-brd-error-code) as a SUCCESSFUL tool result whose text is the error
    // body linking docs.brightdata.com — the pipe's non-URL-fallback then
    // extracted the vendor's docs page as the sole "source", scraped it, stored
    // it to session RAG and digested it as a healthy call (recurring since
    // 2026-09-25). Detect it HERE, retry the transient classes once with
    // backoff, then fail loudly with the provider error code — never ingest.
    let providerError = serp ? serpProviderErrorDetail(String(serp)) : null;
    if (providerError && providerError.retryable) {
      const retryMs = opts?.serpRetryMs ?? serpErrRetryMs();
      // Stated-wait respect (review MINOR-2): for the query-ban codes the
      // vendor documents a 15 s floor ("banned for 15 seconds and immediate
      // retries fail as well") and x-brd-rate-limit-period-ms carries the
      // period on rate-limit responses — an in-band retry before that wait
      // just re-burns a request against a limit the provider already refused.
      // Skip the in-band retry then (the failure text below names the wait);
      // otherwise one bounded backoff retry.
      if ((providerError.minWaitMs ?? 0) > retryMs) {
        logger.warn(`web_pipe: SERP provider error (x-brd-error-code=${providerError.code ?? 'unknown'}${providerError.status ? `, HTTP ${providerError.status}` : ''}) — provider states a ${Math.round((providerError.minWaitMs ?? 0) / 1000)} s minimum wait; skipping the in-band retry (ticket 9b944f30): ${providerError.snippet}`);
      } else {
        logger.warn(`web_pipe: SERP provider error (x-brd-error-code=${providerError.code ?? 'unknown'}${providerError.status ? `, HTTP ${providerError.status}` : ''}${providerError.reqId ? `, req_id=${providerError.reqId}` : ''}) — one backoff retry (ticket 9b944f30): ${providerError.snippet}`);
        onProgress?.(`Search backend error (${providerError.code ?? 'unknown'}) — retrying after backoff…`);
        const firstError = providerError; // review NIT: keep attempt-1's code — a null retry (gateway/circuit) must not lose it
        if (retryMs > 0) await sleep(retryMs);
        serp = await callMcpTool('search_engine', { query: args.query.slice(0, 200), engine: 'google' });
        if (!serp && firstError.code) {
          // The retry itself died (gateway unreachable / circuit open) — the
          // provider code from attempt 1 is still the truthful diagnosis.
          return { ok: false, summary: `${serpBackendFailedSummary(firstError)} The backoff retry then failed to reach the search backend (gateway unreachable / circuit open) — the provider may still be degraded; retry shortly or use search_engine directly.`, sources: [], storedChunks: 0 };
        }
        providerError = serp ? serpProviderErrorDetail(String(serp)) : null;
      }
    }
    if (providerError) {
      // A provider error page is NOT a source set: no scrape, no store, no
      // digest — the explicit failure names the code (throttle vs query-block)
      // so the caller can decide retry vs rephrase.
      logger.warn(`web_pipe: search backend failed (SERP error) — no sources ingested${providerError.code ? ` (x-brd-error-code=${providerError.code})` : ''}${providerError.status ? ` HTTP ${providerError.status}` : ''}: ${providerError.snippet}`);
      return { ok: false, summary: serpBackendFailedSummary(providerError), sources: [], storedChunks: 0 };
    }
    if (serp) {
      const serpText = String(serp);
      // Provider-host filter (ticket 9b944f30, second layer) — NON-JSON path
      // only: targets extracted by the raw-URL regex fallback (a SERP that did
      // NOT parse as JSON organic[]) are exactly where an error body's vendor
      // docs link leaked in as the sole "source". A JSON SERP (organic[] parsed)
      // is a real result set by definition — a legitimate query ABOUT the
      // provider keeps its organic hits; GIVEN urls are the model's own
      // explicit choice and are never filtered (reading the vendor's docs on
      // purpose is a legitimate ask). Only the unvalidated fallback path is.
      const first = serpTargets(serpText);
      targets = first.targets;
      nonJsonSearchSerp = first.nonJson;
      if (first.providerOnly) {
        // Every link the SERP offered was the provider's own host — the
        // incident shape (the sole "source" was docs.brightdata.com).
        zeroSourceNote = 'web_pipe search backend failed (SERP error) — every link the search returned was on the search provider\'s own host (brightdata.com): the provider answered with its own error/docs page instead of results. Retry after backing off or rephrase the query.';
      }
      if (!targets.length && !zeroSourceNote && !webPipeSerpEmptyRetryDisabled()) {
        // Unparseable SERP (2026-10-20): ONE bounded retry before the zero-source answer (see SERP_EMPTY_RETRY_TIMEOUT_MS).
        timing.serpShape = serpShapeOf(serpText);
        logger.info(`web_pipe: search answered but parsed to no links (${timing.serpShape.chars} chars, json=${timing.serpShape.json}, organic key=${timing.serpShape.organicKey}) — one retry`);
        onProgress?.('Search came back unreadable — trying once more…');
        const tRetry = Date.now();
        const retryBoundMs = Math.max(0, opts?.serpEmptyRetryTimeoutMs ?? SERP_EMPTY_RETRY_TIMEOUT_MS);
        const retryErr: { d: SerpProviderError | null } = { d: null };
        let retryTimer: NodeJS.Timeout | undefined;
        const again = await Promise.race([
          callMcpTool('search_engine', { query: args.query.slice(0, 200), engine: 'google' }, retryBoundMs, {
            onSerpProviderError: (d) => { if (!retryErr.d) retryErr.d = d; },
          }).catch(() => null),
          new Promise<null>((resolve) => { retryTimer = setTimeout(() => resolve(null), retryBoundMs); }),
        ]);
        if (retryTimer) clearTimeout(retryTimer);
        timing.retryMs = Date.now() - tRetry;
        const againText = again ? String(again) : '';
        // The retry's own diagnosis wins over the generic note: a classified provider error (tier callback or an
        // in-band error body) names the code; a provider-host-only SERP gets the provider-host note.
        // A tier callback fires per FAILED attempt — a later attempt (or the other tier) can still answer: a non-null
        // SERP is judged on its own body; the callback's diagnosis counts only when the retry returned nothing.
        const providerDetail = againText ? serpProviderErrorDetail(againText) : retryErr.d;
        const second = againText && !providerDetail ? serpTargets(againText) : null;
        if (second && second.targets.length) {
          targets = second.targets;
          nonJsonSearchSerp = second.nonJson;
          timing.serpRetry = 'retried_ok';
        } else if (providerDetail) {
          timing.serpRetry = 'retried_provider_error';
          logger.warn(`web_pipe: the unparseable-SERP retry hit a provider error${providerDetail.code ? ` (x-brd-error-code=${providerDetail.code})` : ''} — no sources ingested`);
          return { ok: false, summary: serpBackendFailedSummary(providerDetail), sources: [], storedChunks: 0 };
        } else {
          timing.serpRetry = 'retried_empty';
          if (second?.providerOnly) {
            zeroSourceNote = 'web_pipe search backend failed (SERP error) — every link the search returned was on the search provider\'s own host (brightdata.com): the provider answered with its own error/docs page instead of results. Retry after backing off or rephrase the query.';
          }
        }
      }
      if (!targets.length && !zeroSourceNote) {
        // Search ANSWERED but nothing parseable: a BrightData throttle-notice
        // page (non-JSON, no organic[].link) and a SERP shape change both land
        // here when the raw-URL fallback also extracts nothing. A notice page
        // that DOES embed some URL falls through to the scrape loop and
        // surfaces its degradation via the unreadable-source note instead.
        zeroSourceNote = 'web_pipe found no sources: search responded but returned no parseable organic links (likely rate-limit/throttle notice page or SERP shape change) — retrying later or rephrasing the query may help.';
      }
    } else {
      // callMcpTool null = gateway unreachable, circuit OPEN after failures, or
      // bounded retries exhausted (mcp-search.ts gatewayTier) — the same
      // degraded class search_engine reports explicitly. On an instance with NO
      // search backend at all (self-host setup hardening 2026-10-20) the honest
      // cause is the configuration, not a degraded provider.
      zeroSourceNote = (lastSearchConfigState()?.anyBackendArmed !== true && !webSearchStatus().configured) ? WEB_PIPE_UNCONFIGURED_NOTE + webSearchProblemSuffix() : 'web_pipe found no sources: the search call failed or was skipped (web-search gateway unreachable / circuit open / rate-limited) — the search provider may be degraded; retry shortly or use search_engine directly.';
    }
  }
  if (!targets.length) {
    timing.targets = 0;
    return { ok: false, summary: zeroSourceNote ?? 'web_pipe found no sources (no urls given and search returned nothing).', sources: [], storedChunks: 0 };
  }

  // ── 1b. Unwrap SERP redirect wrappers BEFORE scraping (2026-09-14) ─────────
  // Since ~2026-09-13 BrightData's Google SERP returns organic[].link as
  // https://www.google.com/goto?url=<opaque> wrappers; scrape_as_markdown on
  // one answers "this endpoint is not supported", so the pipe read 0/4 sources
  // for a whole day. topLinks stays pure — resolve each wrapper's ONE redirect
  // hop here so sources, RAG refs and the same-host grouping below all see the
  // REAL URL/host. Given urls get the same pass (a model may hand back a
  // wrapper it saw in a search_engine result). Non-wrappers never touch the
  // network; two wrappers resolving to the same page collapse to one.
  targets = dedupeTargetsByUrl(await unwrapSerpLinks(targets));

  // ── 1b'. Provider-host filter, POST-unwrap (ticket 9b944f30 review) ────────
  // The pre-unwrap filter above runs on the raw extracted link, so a
  // google.com/goto wrapper RESOLVING to a brightdata.com URL slipped it (the
  // filter saw google.com) and the resolved vendor page was scraped+stored.
  // The answer-key guard below deliberately runs post-unwrap "so a wrapper
  // never hides one" — same convention here: re-filter on the RESOLVED url,
  // but on the SEARCH-DERIVED set only (nonJsonSearchSerp provenance): GIVEN
  // wrappers resolving to the vendor's docs stay (the caller's explicit
  // choice, claim 4) and a JSON organic[] result set stays (a query ABOUT the
  // provider is legitimate — the first filter already skipped it).
  if (nonJsonSearchSerp) {
    const beforeUnwrap = targets.length;
    targets = targets.filter(t => !isProviderSourceUrl(t.url));
    if (beforeUnwrap > targets.length) {
      logger.warn(`web_pipe: dropped ${beforeUnwrap - targets.length} post-unwrap search-derived source(s) resolving to the search provider's own host (ticket 9b944f30)`);
    }
    if (!targets.length) {
      return { ok: false, summary: 'web_pipe search backend failed (SERP error) — every search-derived link resolved to the search provider\'s own host (brightdata.com): the provider answered with its own error/docs page instead of results. Retry after backing off or rephrase the query.', sources: [], storedChunks: 0 };
    }
  }

  // ── 1c. ANSWER-KEY GUARD (2026-10-03, opt-in) ─────────────────────────────
  // A deny-listed target (the benchmark's own repo / dataset / site — after
  // the SERP redirect unwrap, so a wrapper never hides one) is dropped before
  // any scrape; when nothing is left the pipe answers the withheld message.
  if (akGuard) {
    const kept: typeof targets = [];
    for (const t of targets) {
      const label = answerKeyDenyMatch(t.url);
      if (label) akReport({ phase: 'pre', tool: 'web_pipe', label, target: t.url.slice(0, 200) });
      else kept.push(t);
    }
    if (!kept.length) {
      return { ok: false, summary: answerKeyBlockedMessage({ phase: 'pre', tool: 'web_pipe', label: 'every source deny-listed' }), sources: [], storedChunks: 0 };
    }
    targets = kept;
  }

  // ── 2. Scrape — parallel ACROSS hosts, SERIAL within one host ──────────────
  // Ticket e72d9def: firing every scrape as one parallel burst trips per-host
  // bot protection — 4 canlii.org URLs at once got 7/8 pages blocked. Group
  // targets by hostname: groups run in parallel, but within a group scrapes
  // run sequentially with a politeness gap (+jitter), and the gap doubles (to
  // a cap) after each thin/failed same-host scrape, resetting on a good one.
  // Per-call scope only — deliberately no global/cross-call throttle.
  onProgress?.(`Reading ${targets.length} source${targets.length === 1 ? '' : 's'}…`);
  const indexed = targets.map((t, i) => ({ ...t, i }));
  const byHost = new Map<string, typeof indexed>();
  for (const t of indexed) {
    let host = '';
    try { host = new URL(t.url).hostname.toLowerCase(); } catch { /* unparseable — shared '' group */ }
    const g = byHost.get(host);
    if (g) g.push(t); else byHost.set(host, [t]);
  }
  const baseGap = opts?.sameHostGapMs ?? SAME_HOST_GAP_MS;
  const scraped: Array<ScrapedSource | undefined> = new Array(indexed.length);
  const tScrape = Date.now();
  timing.targets = indexed.length;
  // Straggler cut (see EARLY_EXIT_MIN_GOOD) — search-derived targets only. `enough` settles once that many sources read
  // substantively; the cut then waits until every site queue is mid-scrape and that scrape has been in flight long enough
  // to be a straggler. A cut stops the queues from STARTING further scrapes (an in-flight call runs to its own timeout,
  // its result ignored).
  const cutEligible = !givenUrls.length && indexed.length > EARLY_EXIT_MIN_GOOD && !webPipeEarlyExitDisabled();
  const graceMs = Math.max(0, opts?.stragglerGraceMs ?? STRAGGLER_GRACE_MS);
  const minInflightMs = Math.max(0, opts?.stragglerMinInflightMs ?? STRAGGLER_MIN_INFLIGHT_MS);
  const protectedMinInflightMs = Math.max(minInflightMs, opts?.protectedMinInflightMs ?? PROTECTED_MIN_INFLIGHT_MS);
  const started: boolean[] = new Array(indexed.length).fill(false);
  const groups = [...byHost.values()];
  /** Per site queue: when its current scrape started (undefined = between scrapes or done), protected?, finished? */
  const queueState = groups.map(() => ({ inflightSince: undefined as number | undefined, inflightProtected: false, finished: false }));
  let goodSoFar = 0;
  let cut = false;
  let enoughResolve: () => void = () => {};
  const enough = new Promise<void>((resolve) => { enoughResolve = resolve; });
  const countsTowardEnough = (src: ScrapedSource): boolean =>
    src.chars >= EARLY_EXIT_COUNT_MIN_CHARS && !src.text.startsWith('[unfetchable target]') && !(akGuard && answerKeyCanaryMatch(src.text));
  const allScraped = Promise.all(groups.map(async (group, g) => {
    const q = queueState[g];
    let gap = baseGap;
    for (let k = 0; k < group.length; k++) {
      if (cut) return;
      // Polite gap before same-host scrape #k (k>0); gap 0 skips the sleep
      // entirely (tests inject 0) — never sleep on jitter alone.
      if (k > 0 && gap > 0) await sleep(gap + Math.floor(Math.random() * SAME_HOST_JITTER_MS));
      if (cut) return;
      const target = group[k];
      started[target.i] = true;
      q.inflightSince = Date.now();
      // The top search result and PDFs (slower by nature, often the primary source) get the longer in-flight floor.
      q.inflightProtected = target.i === 0 || looksLikePdfUrl(target.url);
      const s = await scrapeOne(target);
      q.inflightSince = undefined;
      if (cut) return; // the pipe already moved on — never write into a snapshot it is digesting
      scraped[target.i] = s; // write by ORIGINAL index — order survives grouping
      gap = nextSameHostGap(gap, s.chars, baseGap);
      if (countsTowardEnough(s) && ++goodSoFar >= EARLY_EXIT_MIN_GOOD) enoughResolve();
    }
    q.finished = true;
  }));
  if (cutEligible) {
    let allDone = false;
    void allScraped.then(() => { allDone = true; });
    await Promise.race([allScraped, enough]);
    if (!allDone) {
      const enoughAt = Date.now();
      const cutDue = (now: number): boolean => {
        if (now < enoughAt + graceMs) return false;
        for (const q of queueState) {
          if (q.finished) continue;
          if (q.inflightSince === undefined) return false; // sleeping its politeness gap — its next page is about to start
          if (now - q.inflightSince < (q.inflightProtected ? protectedMinInflightMs : minInflightMs)) return false;
        }
        return true;
      };
      while (!allDone) {
        if (cutDue(Date.now())) { cut = true; break; }
        let pollTimer: NodeJS.Timeout | undefined;
        await Promise.race([allScraped, new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, CUT_POLL_MS); })]);
        if (pollTimer) clearTimeout(pollTimer);
      }
    }
  } else {
    await allScraped;
  }
  // A slot never written is one the cut left behind (only possible after a cut): in flight ⇒ straggler, never started ⇒ queued.
  const results: ScrapedSource[] = indexed.map(({ i: _i, ...t }, k) => scraped[k] ?? { ...t, text: '', chars: 0, note: started[k] ? STRAGGLER_NOTE : NOT_STARTED_NOTE });
  timing.scrapeMs = Date.now() - tScrape;
  timing.stragglers = results.filter(r => r.note === STRAGGLER_NOTE).length;
  timing.notStarted = results.filter(r => r.note === NOT_STARTED_NOTE).length;
  // ANSWER-KEY GUARD (opt-in): a page carrying a benchmark canary is emptied
  // BEFORE the store / digest — it never reaches session memory or the summary.
  if (akGuard) {
    for (const s of results) {
      const label = s.text ? answerKeyCanaryMatch(s.text) : null;
      if (!label) continue;
      akReport({ phase: 'post', tool: 'web_pipe', label, target: s.url.slice(0, 200) });
      s.text = '';
      s.chars = 0;
      s.note = 'withheld by the answer-key guard (benchmark answer-key / test material)';
    }
  }
  const good = results.filter(s => s.chars > MIN_GOOD_CHARS);
  timing.good = good.length;
  if (!good.length) {
    const noteLines = results.filter(s => s.note).map(s => `- ${s.url}: ${s.note}`);
    return {
      ok: false,
      summary: `web_pipe could not read any of the ${targets.length} source(s).${!webSearchStatus().configured ? ' Web page fetching is NOT configured on this Digby instance (no BrightData token or MCP gateway), so no URL can be read here — do not retry; an admin enables web search in Account → Admin → Setup.' : ''}${noteLines.length ? `\n${noteLines.join('\n')}` : ''}`,
      sources: results.map(s => ({ url: s.url, title: s.title, chars: s.chars, stored: false, note: s.note, status: s.status })),
      storedChunks: 0,
    };
  }

  // ── 3. Embed to session RAG (the store search_memory reads) ────────────────
  // Fast digest: the store runs IN PARALLEL with the digest (awaited before the return); otherwise first, as before.
  const fastDigest = !webPipeFastDigestDisabled();
  timing.fastDigest = fastDigest;
  const tStore = Date.now();
  const storePromise: Promise<number> = (sessionId
    ? storeFindings(sessionId, 'web_pipe',
        good.map(s => ({ ref: s.title ? `${s.title} — ${s.url}` : s.url, content: s.text.slice(0, 24_000) })),
      ).catch(() => 0)
    : Promise.resolve(0)).then((n) => { timing.storeMs = Date.now() - tStore; return n; });
  let stored = fastDigest ? 0 : await storePromise;

  // ── 4. ONE summarize call (Qwen) — digest + RAG directions ─────────────────
  onProgress?.('Digesting…');
  const tDigest = Date.now();
  const focusLine = args.focus ? `\nFOCUS: ${args.focus}` : '';
  const corpus = good.map((s, i) => `--- SOURCE ${i + 1}: ${s.title || s.url} (${s.url}) ---\n${s.text.slice(0, 9000)}`).join('\n\n');
  let digestText: string | null = null;
  let digestAttribution: string | undefined;
  let digestModel: string | undefined;
  const ragHintsAsked = fastDigest && !!sessionId;
  try {
    // Gate on the store actually SUCCEEDING (owner 2026-09-04): a swallowed
    // storeFindings failure used to yield a digest promising search_memory
    // queries for content that never landed — teaching the model the pointers
    // are unreliable. Fast digest: the store is still running, so the queries go
    // under RAG_QUERIES_MARKER and are stripped below when it landed nothing.
    const ragItem = fastDigest
      ? (ragHintsAsked ? `\n3. Last, a line "${RAG_QUERIES_MARKER}" followed by 2-3 suggested search_memory queries for retrieving stored detail.` : '')
      : (stored > 0 ? '\n3. 2-3 suggested search_memory queries for retrieving stored detail.' : '');
    const digest = await qwenSummarize(
      fastDigest
        ? `Digest these web sources in at most ${DIGEST_WORD_TARGET} words in total:\n1. A tight summary of the key facts/figures (cite which source).\n2. One short line per source: what it contains.${ragItem}${focusLine}\n\n${corpus}`
        : `Digest these web sources into:\n1. A tight summary of the key facts/figures (cite which source).\n2. One line per source: what it contains.${ragItem}${focusLine}\n\n${corpus}`,
      undefined,
      sessionId,
      fastDigest ? FAST_DIGEST_MAX_TOKENS : undefined,
    );
    digestText = digest.text;
    digestAttribution = digest.attribution;
    digestModel = digest.model;
  } catch (err: any) {
    // Includes the EMPTY-answer case (HelperEmptyAnswerError names the model and
    // the fix) — never return a blank digest as success.
    logger.warn(`web_pipe: summarize failed (${err.message}) — returning index only`);
  }
  timing.digestMs = Date.now() - tDigest;
  if (fastDigest) stored = await storePromise;
  // Hints only where they were asked for and only when the store landed (stripping the TEXT, never the attribution).
  const body = digestText !== null && ragHintsAsked && stored === 0 ? stripRagQueries(digestText) : digestText;
  // Helper-seat health fallback (owner 2026-09-14): when the custom seat
  // failed and the built-in wrote the digest, say so IN the digest — the
  // model relays it and the owner learns the seat is unhealthy instead of
  // reading a silently re-seated answer.
  const text = body || good.map((s, i) => `${i + 1}. ${s.title || s.url} — ${s.url} (${s.chars} chars ${stored > 0 ? 'stored' : 'read'})`).join('\n');
  const summary = !digestAttribution ? text
    : body ? `${text}\n\n[${digestAttribution}]`
    : `${text}\n\n[${digestAttribution} — that digest held only search_memory hints, dropped because nothing was stored]`;
  if (!body) digestModel = undefined;
  timing.digestChars = summary.length;

  return {
    ok: true,
    summary,
    sources: results.map(s => ({ url: s.url, title: s.title, chars: s.chars, stored: s.chars > MIN_GOOD_CHARS, note: s.note, status: s.status })),
    storedChunks: stored,
    ...(digestModel ? { model: digestModel } : {}),
  };
}
