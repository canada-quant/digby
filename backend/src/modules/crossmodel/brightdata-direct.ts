/**
 * BrightData DIRECT REST client — the hardened failover tier (2026-07-14).
 *
 * Every web-search outage we've had was OUR gateway plumbing (supergateway child
 * OOM-kills, parent memory leak, hung bridge) — BrightData itself answered in
 * seconds whenever probed directly. This module calls BrightData's REST API
 * (api.brightdata.com/request — the exact API the @brightdata/mcp server wraps)
 * straight from the backend: no gateway container, no MCP bridge, no child
 * process. `callMcpTool` fails over here for the three hot tools, so web
 * search/scrape keeps working through ANY gateway failure mode.
 *
 * Env: BRIGHTDATA_API_TOKEN (+ BRIGHTDATA_WEB_UNLOCKER_ZONE, default
 * web_unlocker1) — passed to the backend container via docker-compose.app.yml.
 */

import axios from 'axios';
import logger from '../../utils/logger';
import { logExternal } from '../../utils/log-level';
import { isZoneErrorCode } from './platform/brightdata-zone';
import { recordZoneFailure } from './platform/search-config-state';

const BD_REQUEST_URL = 'https://api.brightdata.com/request';
const TOKEN = process.env.BRIGHTDATA_API_TOKEN;
const UNLOCKER_ZONE = process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE || 'web_unlocker1';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Deterministic content failure: BrightData answered, but the target page has
 * no extractable content (PDF, image, JS-shell SPA, hard block). This is NOT a
 * plumbing failure — retrying the same page via the gateway tier (the SAME
 * BrightData backend) just burns ~30s attempts and floods logs (prod: ~820
 * warns/48h, issue #85), so callMcpTool skips the gateway for this one case.
 */
export class DirectEmptyBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectEmptyBodyError';
  }
}

/**
 * Upstream rejection: BrightData answered HTTP 200 but carried structured
 * error headers (x-brd-err-code) — the zone/ACL/credential layer refused the
 * request. This is ALWAYS a loud failure (warn): our config is wrong, not the
 * target page. The 2026-08-06 ca-cutover outage (407 ip_forbidden /
 * client_10030 after the egress IP changed) stayed invisible for ~a day
 * because BrightData wraps such rejections as 200 + empty body, which looked
 * identical to a deterministic empty page.
 */
export class DirectUpstreamError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DirectUpstreamError';
  }
}

/**
 * ZONE CONFIG ERROR (ticket 02f8c83f): Bright Data answered HTTP **200 with a
 * zero-byte body** because the zone named in the request does not exist on the
 * account — the truth only appears in headers (`x-brd-status-code: 407`,
 * `x-brd-err-code: client_10002`, `x-brd-error: Zone not found`).
 *
 * This is a DISTINCT class from a generic upstream rejection and from a
 * deterministic empty page, because it is neither a bad target nor a transient
 * blip: OUR configuration is wrong, EVERY search and scrape will keep
 * answering 200-with-nothing, and the only fix is the operator naming a zone
 * that exists. Live evidence (digby.cql.ca, 2026-11-06): the stored row had
 * `zone: null` → the hardcoded default 'web_unlocker1' → every SERP and scrape
 * silently returned nothing for hours while the settings page showed a saved,
 * readable key. Recording it (search-config-state.recordZoneFailure) is what
 * lets Admin → Settings → Web search stop showing a dead default as healthy.
 */
export class DirectZoneError extends DirectUpstreamError {
  constructor(
    code: string,
    status: number,
    message: string,
    public readonly zone: string,
  ) {
    super(code, status, message);
    this.name = 'DirectZoneError';
  }
}

/**
 * DIRECT-tier MISS CLASS (backlog audit PE-06, 2026-09-28). The direct
 * search_engine tier answered nothing in ~35 % of prod searches (592/1,674 over
 * 7 d) and nothing recorded WHY — the "returned nothing" warn carried no body
 * class. tryDirectBrightData now hands its caller a DirectMissInfo through
 * `opts.onMiss` for every null it returns, and callMcpTool records it as
 * `directClass` on the web_fetch_path row. Classes:
 *   timeout | empty_body | serp_<bodyClass> | upstream_<x-brd-err-code> |
 *   http_<status> | net_<code> | no_token | error
 * where bodyClass (classifySerpBody) is one of consent | captcha | redirect |
 * json_no_organic | json_malformed | html | other, and a zone rejection is
 * `zone_<x-brd-err-code>` (ticket 02f8c83f — a 200-with-empty-body because the
 * zone does not exist, NEVER reported as "no results").
 */
export interface DirectMissInfo {
  class: string;
  status?: number;
  code?: string;
  detail?: string;
}

/** A SERP body BrightData answered with that carries no `organic` key —
 *  classified so the telemetry can say consent page vs captcha vs JSON shape. */
export class DirectSerpShapeError extends Error {
  constructor(public readonly bodyClass: string) {
    super(`direct SERP response missing organic results (${bodyClass})`);
    this.name = 'DirectSerpShapeError';
  }
}

const SERP_CLASS_SAMPLE_CHARS = 4000;

/**
 * Classify a SERP body that failed the `"organic":` sanity check. Pure —
 * looks at the first 4k chars only; never throws.
 */
export function classifySerpBody(text: string): string {
  const head = String(text || '').slice(0, SERP_CLASS_SAMPLE_CHARS);
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(String(text));
      return 'json_no_organic';
    } catch {
      return 'json_malformed';
    }
  }
  if (/consent\.google\.|before you continue to google|consent\.youtube/i.test(head)) return 'consent';
  if (/recaptcha|captcha|unusual traffic|\/sorry\/index|automated queries/i.test(head)) return 'captcha';
  if (/<meta[^>]+http-equiv=["']?refresh|document has moved|30[1278] (moved|found|redirect)|location\.replace\(/i.test(head)) return 'redirect';
  if (/<!doctype html|<html/i.test(head)) return 'html';
  return 'other';
}

/** Map any direct-tier failure to its DirectMissInfo (pure; never throws). */
export function classifyDirectMiss(err: any): DirectMissInfo {
  // Zone rejection FIRST: it is a DirectUpstreamError subclass, but it is a
  // CONFIG error (the zone does not exist), not an ACL/policy refusal — the
  // class must be distinguishable so telemetry and the admin surface never
  // file it as "returned no results" (ticket 02f8c83f).
  if (err instanceof DirectZoneError) return { class: `zone_${err.code}`, status: err.status, code: err.code, detail: err.zone };
  if (err instanceof DirectUpstreamError) return { class: `upstream_${err.code}`, status: err.status, code: err.code };
  if (err instanceof DirectSerpShapeError) return { class: `serp_${err.bodyClass}`, detail: err.bodyClass };
  if (err instanceof DirectEmptyBodyError) return { class: 'empty_body' };
  if (err?.code === 'ECONNABORTED') return { class: 'timeout', code: 'ECONNABORTED' };
  const status = err?.response?.status;
  if (typeof status === 'number') return { class: `http_${status}`, status };
  if (typeof err?.code === 'string' && err.code) return { class: `net_${err.code}`, code: err.code };
  return { class: 'error', detail: String(err?.message || err || '').slice(0, 120) };
}

/**
 * UNFETCHABLE TARGETS (autonomy loop #19, 2026-09-21). BrightData's unlocker
 * refuses raw-IP hosts, private/loopback names and non-standard ports by
 * policy (x-brd-err-code policy_20020 — live: a health-watch lane asked for
 * http://89.124.36.202:4000/v1/models 26× in 4 h: direct tier → refused →
 * gateway tier → refused, ~40 s and two warn lines per attempt, and the model
 * only ever saw "no content"). Classify BEFORE the request and tell the model
 * how to reach such an endpoint (curl from the sandbox). Hosts BrightData
 * refuses by policy are memoized for POLICY_REFUSAL_MEMO_MS so repeats fail
 * fast with the same guidance.
 */
export class DirectUnfetchableTargetError extends DirectEmptyBodyError {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`unfetchable target: ${reason}`);
    this.name = 'DirectUnfetchableTargetError';
  }
}
export const POLICY_REFUSAL_MEMO_MS = 60 * 60 * 1000;
const policyRefusedHosts = new Map<string, number>();
export function __resetPolicyRefusalsForTest(): void { policyRefusedHosts.clear(); }

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
export function rememberPolicyRefusal(url: string, now: number = Date.now()): void {
  const h = hostOf(url);
  if (h) policyRefusedHosts.set(h, now + POLICY_REFUSAL_MEMO_MS);
}
/** Why the cloud fetcher cannot serve this URL, or null when it looks fetchable. */
export function classifyUnfetchableTarget(url: string, now: number = Date.now()): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'not a valid absolute URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported scheme ${u.protocol}`;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return `private hostname ${host}`;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return `raw IP address host ${host}`;
  if (u.port && u.port !== '80' && u.port !== '443') return `non-standard port ${u.port}`;
  const until = policyRefusedHosts.get(host);
  if (until && until > now) return `BrightData refused this host by policy (policy_20020) within the last ${Math.round(POLICY_REFUSAL_MEMO_MS / 60000)} min`;
  if (until) policyRefusedHosts.delete(host);
  return null;
}
/** The text the model receives instead of "no content" — names the reason and the working alternative. */
export function unfetchableGuidance(url: string, reason: string): string {
  return `[unfetchable target] The cloud fetcher cannot reach ${url.slice(0, 200)}: ${reason}. It serves public hostnames on ports 80/443 only. `
    + `To read this endpoint run it from the sandbox instead, e.g. run_command: curl -sS --max-time 20 '${url.slice(0, 200).replace(/'/g, "'\\''")}'`;
}

let _warnedNoToken = false;

/**
 * Direct-tier credentials for THIS request (ticket 6f4d42f2). ENV FIRST — a
 * cloud deploy's BRIGHTDATA_API_TOKEN always wins and the admin store is
 * never consulted for it; when env is absent, the instance-wide admin store
 * (Admin → Settings → Web search, searchProviderConfig) supplies the key +
 * zone for self-hosted/Edge instances. Null = no credential anywhere (the
 * direct tier cannot run). Resolved PER REQUEST, never cached at module
 * scope: an admin saving a key must take effect within the resolver's 30 s
 * cache, and the module-level TOKEN const (read once at import) is kept ONLY
 * as the env-side snapshot for the fast path.
 */
export interface DirectBrightDataCreds {
  token: string;
  zone: string;
  /** 'env' | 'store' — which side supplied the token (telemetry/status). */
  source: 'env' | 'store';
}

/** The env-only credentials, or null when BRIGHTDATA_API_TOKEN is unset (fast path — no store read). */
function envCreds(): DirectBrightDataCreds | null {
  if (!TOKEN) return null;
  return { token: TOKEN, zone: UNLOCKER_ZONE, source: 'env' };
}

/** The last store resolution seen in this process (a one-slot memo so the
 *  pre-flight availability check in the sync directBrightDataAvailable()
 *  reflects the store too, without making that function async). Refreshed by
 *  every direct call attempt, every resolveDirectBrightDataCreds() await, and
 *  mcp-search's per-call pre-flight (noteStoreCredsForAvailability). */
let _lastStoreCreds: { at: number; creds: { token: string; zone: string; source: 'store' } | null } | null = null;
const STORE_MEMO_TTL_MS = 30_000;

/** Prime the store-creds memo from an EXTERNAL resolution (reviewer Blocking 1,
 *  ticket 6f4d42f2). The sync directBrightDataAvailable() gate reads this memo,
 *  but it was previously written ONLY inside resolveDirectBrightDataCreds() —
 *  whose callers are reachable only THROUGH the gate itself, so on a store-only
 *  instance (no env token) the memo never warmed, the direct tier never armed,
 *  and every search/scrape silently returned null. mcp-search's per-call
 *  pre-flight resolves the composite credential state BEFORE the gate runs in
 *  the same call and feeds the STORE leg here. Pure setter — never throws,
 *  never reads env; null primes "store resolved empty", which is also the
 *  self-heal path after the resolver's 30 s cache expires. */
export function noteStoreCredsForAvailability(creds: { token: string; zone: string } | null): void {
  _lastStoreCreds = {
    at: Date.now(),
    creds: creds ? { token: creds.token, zone: creds.zone, source: 'store' } : null,
  };
}

/** Env-first, store-fallback credential resolution (async — the store read is
 *  cached 30 s server-side). This is the ONE resolution path; direct calls
 *  take creds as a parameter so tests can pin the order deterministically. */
export async function resolveDirectBrightDataCreds(): Promise<DirectBrightDataCreds | null> {
  const env = envCreds();
  if (env) return env; // env precedence — the store can never override it
  // Dynamic import on purpose (ticket 6f4d42f2): brightdata-direct is loaded
  // by suites that mock axios/logger only, and the platform service drags the
  // prisma client — the tool-executor → premise-register idiom keeps this
  // module import-light until credentials are actually needed. The WHOLE store
  // leg is best-effort: a module-load failure (env validation in the store
  // module's import graph, e.g. in a jest suite that mocks axios only) or a
  // store read failure degrades to "no store creds" — the gateway tier and
  // the not-configured message own the rest, never a thrown error.
  try {
    const { resolveStoreBrightDataCredentials, resolveWireZone } = await import('./platform/search-provider-config');
    const store = await resolveStoreBrightDataCredentials();
    if (store) {
      // F1 (ticket 02f8c83f): the zone on the wire MUST come from the one
      // shared resolver — computing it locally (store.zone || DEFAULT) made the
      // admin panel report a different zone than the tier actually used, which
      // is how a dead stored zone rendered as verified (and a good one as dead)
      // on every compose install (the env zone is always set there).
      const creds = { token: store.token, zone: resolveWireZone(store.zone), source: 'store' as const };
      _lastStoreCreds = { at: Date.now(), creds };
      return creds;
    }
    _lastStoreCreds = { at: Date.now(), creds: null };
    return null;
  } catch {
    _lastStoreCreds = { at: Date.now(), creds: null };
    return null;
  }
}

/**
 * Direct tier is usable (a token is resolvable from env OR the admin store).
 * Synchronous best-effort: reflects env at import + the last store
 * resolution seen (within its memo TTL). The authoritative per-call check is
 * the creds parameter tryDirectBrightData/bdRequest receive — this function
 * only gates the module-level "is the direct tier dead" log + routing hints.
 * Warns ONCE per process when NO credential is resolvable — a token-less
 * deployment previously fell through to the gateway tier with zero trace.
 */
export function directBrightDataAvailable(): boolean {
  const storeFresh = _lastStoreCreds && Date.now() - _lastStoreCreds.at < STORE_MEMO_TTL_MS ? _lastStoreCreds.creds : null;
  const any = !!(TOKEN || storeFresh);
  if (!any && !_warnedNoToken) {
    _warnedNoToken = true;
    logger.warn(
      'BrightData direct: no API token resolvable (env BRIGHTDATA_API_TOKEN unset and no admin store key — set one in Admin → Settings → Web search on self-hosted) — ' +
      'direct tier disabled; every search/scrape falls through to the gateway tier',
      { source: 'brightdata-direct', tool: 'direct-tier' },
    );
  }
  return any;
}

/** Test seam: reset the once-per-process no-token warn + the store memo. */
export function __resetDirectCredsForTest(): void {
  _warnedNoToken = false;
  _lastStoreCreds = null;
}

/**
 * Transient vendor-edge failures get bounded retries with short backoff.
 * Observed prod pattern (2026-08-08): ~1/3 of SERP calls failed FAST (raw 403/502
 * from the BrightData edge, interleaved with 200s on identical config and a
 * passing whitelist) — a retry-after-400ms succeeds most of the time.
 * NEVER retried: DirectUpstreamError / DirectEmptyBodyError (deterministic —
 * config/content problems don't heal in 400ms) and our own timeouts
 * (ECONNABORTED — the target was slow; retrying triples worst-case latency).
 */
const BD_MAX_ATTEMPTS = 3;
const BD_RETRY_BACKOFF_MS = [400, 1200];
/** Small additive jitter so concurrent retries (scrape_batch fan-out, parallel
 *  model searches) don't re-hit a rate-limited edge in a synchronized burst. */
const BD_RETRY_JITTER_MS = 250;
/** 403 is often transient at the BrightData edge (the observed prod pattern),
 *  but a revoked token / disabled zone 403s forever — retry it at most ONCE,
 *  then fail fast to the gateway tier instead of burning the full loop. */
const BD_MAX_403_ATTEMPTS = 2;
/** Overall budget spanning ALL attempts of one request, as a multiple of the
 *  per-attempt timeout. A slow failing attempt (the unlocker can hold a
 *  hard-blocked page for tens of seconds before answering 5xx) must not stack
 *  3 full timeouts in front of the gateway tier, which retries the same
 *  backend up to 4 more times. */
const BD_TOTAL_BUDGET_FACTOR = 1.5;
/** Honor a Retry-After response header up to this cap (the overall deadline
 *  still wins — a Retry-After that pushes past it means give up now). */
const BD_RETRY_AFTER_CAP_MS = 15_000;
/** Shared retry allowance for scrape_batch: 5 concurrent URLs each running the
 *  full retry loop turn one 429 into a synchronized 15-request burst — cap the
 *  batch-wide retries instead. */
const BD_BATCH_RETRY_BUDGET = 4;
const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const RETRYABLE_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPROTO', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT']);

/** Retry allowance shared by the concurrent bdRequests of one scrape_batch. */
interface BdRetryBudget { remaining: number }

function isRetryableBdError(err: any): boolean {
  const status = err?.response?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  if (err?.code === 'ECONNABORTED') return false; // our timeoutMs fired — slow target, not a transient
  return typeof err?.code === 'string' && RETRYABLE_NET_CODES.has(err.code);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to ms, capped. */
function parseRetryAfterMs(err: any): number | null {
  const raw = err?.response?.headers?.['retry-after'];
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10) * 1000, BD_RETRY_AFTER_CAP_MS);
  const when = Date.parse(s);
  if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), BD_RETRY_AFTER_CAP_MS);
  return null;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function bdRequest(body: Record<string, any>, timeoutMs: number, retryBudget?: BdRetryBudget, creds?: DirectBrightDataCreds): Promise<string> {
  const deadline = Date.now() + Math.round(timeoutMs * BD_TOTAL_BUDGET_FACTOR);
  for (let attempt = 1; attempt <= BD_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await axios.post(BD_REQUEST_URL, body, {
        headers: { Authorization: `Bearer ${creds ? creds.token : TOKEN}`, 'Content-Type': 'application/json' },
        // Per-attempt timeout never exceeds what's left of the overall budget.
        timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
        // BrightData returns the target's body (string) with format:'raw'.
        responseType: 'text',
        transformResponse: [(d: any) => d],
      });
      // BrightData's API wraps zone-level rejections (IP not whitelisted, zone
      // suspended, bad credentials) as HTTP 200 + empty body + structured error
      // headers. Classify on the headers FIRST so an upstream rejection is always
      // loud and never masquerades as a deterministic empty page (see
      // DirectUpstreamError doc).
      const errCode = r.headers?.['x-brd-err-code'] ?? r.headers?.['x-brd-err_code'];
      if (errCode) {
        const zone = String(body?.zone ?? (creds ? creds.zone : UNLOCKER_ZONE));
        const detail = String(r.headers?.['x-brd-err'] || r.headers?.['x-brd-err-msg'] || 'BrightData upstream rejection');
        // The REAL cause code is in x-brd-status-code (407 'Zone not found');
        // r.status is 200 — reporting http=200 next to "does not exist" reads
        // like a success (reviewer F7).
        const providerStatus = Number(r.headers?.['x-brd-status-code']) || r.status;
        // A ZONE rejection is a CONFIG error, not an ACL/policy one: the zone in
        // the request does not exist on the account, so EVERY call will keep
        // answering 200-with-nothing. Record it for the admin surface, then throw
        // the distinct class so telemetry says zone_<code>, never "no results".
        if (isZoneErrorCode(errCode)) {
          recordZoneFailure({ at: Date.now(), zone, code: String(errCode) });
          throw new DirectZoneError(String(errCode), providerStatus, detail, zone);
        }
        throw new DirectUpstreamError(String(errCode), providerStatus, detail);
      }
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '');
      if (!text || !text.trim()) throw new DirectEmptyBodyError('empty body from BrightData direct');
      if (attempt > 1) logger.info(`BrightData direct: recovered on attempt ${attempt}/${BD_MAX_ATTEMPTS}`);
      return text;
    } catch (err: any) {
      if (err instanceof DirectUpstreamError || err instanceof DirectEmptyBodyError) throw err;
      if (attempt >= BD_MAX_ATTEMPTS || !isRetryableBdError(err)) throw err;
      // Permanent auth/zone 403s (revoked token, disabled zone) never heal —
      // one retry covers the observed transient-edge pattern, then fail fast.
      if (err?.response?.status === 403 && attempt >= BD_MAX_403_ATTEMPTS) throw err;
      // Batch-wide retry allowance exhausted (scrape_batch fan-out).
      if (retryBudget && retryBudget.remaining <= 0) throw err;
      const base = BD_RETRY_BACKOFF_MS[attempt - 1] ?? BD_RETRY_BACKOFF_MS[BD_RETRY_BACKOFF_MS.length - 1];
      const retryAfterMs = parseRetryAfterMs(err);
      const backoff = Math.max(base, retryAfterMs ?? 0) + Math.floor(Math.random() * BD_RETRY_JITTER_MS);
      // Out of overall budget — hand off to the gateway tier instead of
      // stacking another full-timeout attempt behind a slow failure.
      if (Date.now() + backoff >= deadline) throw err;
      if (retryBudget) retryBudget.remaining--;
      logger.warn(
        `BrightData direct: transient ${err.response?.status || err.code || err.message} ` +
        `(attempt ${attempt}/${BD_MAX_ATTEMPTS}) — retrying in ${backoff}ms`,
        { source: 'brightdata-direct', tool: 'bd-request-retry' },
      );
      await sleep(backoff);
    }
  }
  throw new Error('unreachable'); // loop always returns or throws
}

/** SERP via the unlocker zone with brd_json=1 → parsed JSON ({organic:[...]}) —
 *  the same payload shape the MCP's search_engine returns as text. */
export async function directSearchEngine(query: string, engine: 'google' | 'bing' = 'google', timeoutMs = DEFAULT_TIMEOUT_MS, creds?: DirectBrightDataCreds): Promise<string> {
  const base = engine === 'bing' ? 'https://www.bing.com/search' : 'https://www.google.com/search';
  const url = `${base}?q=${encodeURIComponent(query)}&brd_json=1`;
  const text = await bdRequest({ zone: creds ? creds.zone : UNLOCKER_ZONE, url, format: 'raw' }, timeoutMs, undefined, creds);
  // Sanity: parsed SERP JSON must carry results; a block/captcha page would not.
  if (!/"organic"\s*:/.test(text)) throw new DirectSerpShapeError(classifySerpBody(text));
  logger.info(`BrightData direct: SERP ok for "${query.slice(0, 50)}" (${text.length} chars)`);
  return text;
}

/** Scrape one URL to markdown via the unlocker zone (data_format: markdown). */
export async function directScrapeMarkdown(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, retryBudget?: BdRetryBudget, creds?: DirectBrightDataCreds): Promise<string> {
  const text = await bdRequest({ zone: creds ? creds.zone : UNLOCKER_ZONE, url, format: 'raw', data_format: 'markdown' }, timeoutMs, retryBudget, creds);
  logger.info(`BrightData direct: scrape ok for "${url.slice(0, 60)}" (${text.length} chars)`);
  return text;
}

/**
 * Rendered page screenshot via the unlocker zone (data_format: screenshot —
 * the Web Unlocker renders the page and returns a PNG). Used ONLY as the
 * browser panel's live view for cloud (read-only scrape) browsing (2026-09-09):
 * the cloud driver has no live browser session, so without this the panel
 * showed "text mode — no visual preview" for every cloud browse. Best-effort by
 * contract: returns null on any failure (no token, upstream refusal, timeout,
 * non-image body) — the caller never blocks the model loop on it.
 */
export async function directScreenshotPng(url: string, timeoutMs = 30_000): Promise<string | null> {
  const creds = await resolveDirectBrightDataCreds();
  if (!creds || !url) return null;
  // Loop #19: an unfetchable target never reaches the unlocker (26 refused
  // screenshots of one raw-IP endpoint in 4 h); the panel shows text mode.
  const why = classifyUnfetchableTarget(url);
  if (why) { logger.info(`BrightData direct: screenshot skipped for "${url.slice(0, 60)}" — ${why}`); return null; }
  try {
    const r = await axios.post(BD_REQUEST_URL, { zone: creds.zone, url, format: 'raw', data_format: 'screenshot' }, {
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
      responseType: 'arraybuffer',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const errCode = r.headers?.['x-brd-err-code'];
    if (errCode) {
      if (String(errCode).startsWith('policy_')) rememberPolicyRefusal(url);
      logger.warn(`BrightData direct: screenshot refused upstream (${errCode}) for "${url.slice(0, 60)}"`, { source: 'brightdata-direct', tool: 'screenshot' });
      return null;
    }
    const buf = Buffer.from(r.data as ArrayBuffer);
    // PNG magic — anything else (an HTML error page, an empty body) is not a preview.
    if (buf.length < 100 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    return buf.toString('base64');
  } catch (e: any) {
    logger.info(`BrightData direct: screenshot unavailable for "${url.slice(0, 60)}": ${e?.message || e}`);
    return null;
  }
}

/**
 * Failover dispatcher used by callMcpTool: handles the three hot tools with the
 * same result shapes the MCP versions produce. Returns null for tools the direct
 * tier doesn't cover (browser_*, web_data_*) or when the token is absent.
 */
export async function tryDirectBrightData(
  toolName: string,
  args: Record<string, any>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /** PE-06: receives the miss class for every null this call returns (never for a thrown deterministic empty). */
  opts?: { onMiss?: (miss: DirectMissInfo) => void },
): Promise<string | null> {
  const noteMiss = (miss: DirectMissInfo) => {
    try { opts?.onMiss?.(miss); } catch { /* telemetry only */ }
  };
  // Ticket 6f4d42f2: env-first, store-fallback credentials resolved PER CALL —
  // an admin saving a key in Admin → Settings arms the direct tier within the
  // 30 s resolver cache without a process restart. Null creds = the direct
  // tier cannot run on this instance (no env token, no admin store key).
  const creds = await resolveDirectBrightDataCreds();
  if (!creds) {
    noteMiss({ class: 'no_token' });
    return null;
  }
  try {
    if (toolName === 'search_engine') {
      const engine = args.engine === 'bing' ? 'bing' : 'google';
      return await directSearchEngine(String(args.query || ''), engine, timeoutMs, creds);
    }
    if (toolName === 'scrape_as_markdown') {
      const url = String(args.url || '');
      const why = classifyUnfetchableTarget(url);
      if (why) throw new DirectUnfetchableTargetError(url, why); // deterministic — skips the gateway too
      return await directScrapeMarkdown(url, timeoutMs, undefined, creds);
    }
    if (toolName === 'scrape_batch') {
      const urls: string[] = Array.isArray(args.urls) ? args.urls.slice(0, 5) : [];
      if (!urls.length) return null;
      // One retry allowance shared across the whole batch: without it a single
      // 429 turns 5 concurrent URLs × 2 retries each into a synchronized
      // 15-request burst against the limiter that just said slow down.
      const retryBudget: BdRetryBudget = { remaining: BD_BATCH_RETRY_BUDGET };
      const results = await Promise.all(urls.map(u => {
        const why = classifyUnfetchableTarget(String(u));
        if (why) return Promise.resolve(`## ${u}\n\n[scrape failed: unfetchable target: ${why} — read it from the sandbox with run_command curl]`);
        return directScrapeMarkdown(String(u), timeoutMs, retryBudget, creds)
          .then(md => `## ${u}\n\n${md}`)
          .catch(e => {
            // Upstream rejections must stay loud even when batched — the inline
            // text alone would repeat the 2026-08-06 invisible-outage pattern.
            if (e instanceof DirectZoneError) {
              logger.warn(
                `BrightData direct: scrape_batch URL ${String(u).slice(0, 60)} ZONE CONFIG ERROR — zone "${e.zone}" does not exist` +
                ` (x-brd-err-code=${e.code}); every search/scrape answers 200 with an empty body until a real zone is saved`,
                { source: 'brightdata-direct', tool: 'scrape_batch' },
              );
            } else if (e instanceof DirectUpstreamError) {
              logger.warn(
                `BrightData direct: scrape_batch URL ${String(u).slice(0, 60)} UPSTREAM rejection` +
                ` (x-brd-err-code=${e.code}, http=${e.status}) — ${e.message}`,
                { source: 'brightdata-direct', tool: 'scrape_batch' },
              );
            }
            if (e instanceof DirectUpstreamError && String(e.code).startsWith('policy_')) rememberPolicyRefusal(String(u));
            return `## ${u}\n\n[scrape failed: ${e.message}]`;
          });
      }));
      return results.join('\n\n---\n\n');
    }
    return null; // tool not covered by the direct tier
  } catch (err: any) {
    // ZONE CONFIG ERROR (ticket 02f8c83f) — the zone does not exist on the
    // account, so EVERY search/scrape answers 200 + empty body. Say that, out
    // loud, instead of the generic upstream wording: an operator reading the
    // logs must be told to fix the ZONE, not to check the target page or retry.
    if (err instanceof DirectZoneError) {
      logger.warn(
        `BrightData direct: ${toolName} ZONE CONFIG ERROR — zone "${err.zone}" does not exist on this account` +
        ` (x-brd-err-code=${err.code}, http=${err.status}, "${err.message}"); every search will answer 200 with an empty body` +
        ' until Admin → Settings → Web search names a zone that exists (GET https://api.brightdata.com/zone/get_active_zones)',
        { source: 'brightdata-direct', tool: toolName },
      );
      noteMiss(classifyDirectMiss(err));
      return null;
    }
    // Upstream rejection (ACL/zone/credentials refused): loud + specific —
    // config is broken, not the page. Still null (gateway may route around).
    if (err instanceof DirectUpstreamError) {
      // A POLICY refusal is about the TARGET, not our config: memo the host so
      // the next attempt fails fast with guidance instead of another round trip.
      if (String(err.code).startsWith('policy_') && args?.url) rememberPolicyRefusal(String(args.url));
      logger.warn(
        `BrightData direct: ${toolName} UPSTREAM rejection (x-brd-err-code=${err.code}, http=${err.status})` +
        ` — ${err.message}; falling back to gateway tier`,
        { source: 'brightdata-direct', tool: toolName },
      );
      noteMiss(classifyDirectMiss(err));
      return null;
    }
    // Deterministic empty-body (PDF / blocked / JS-shell page): log at info —
    // this is an expected content outcome, not a failure (~17/hr in prod). For
    // scrape_as_markdown, rethrow so callMcpTool can SKIP the gateway tier (the
    // same BrightData backend would return empty too — burning ~30s/attempt and
    // flooding warns, issue #85). For search_engine keep the old contract (null
    // → gateway failover): an empty SERP body can be a transient hiccup.
    if (err instanceof DirectEmptyBodyError) {
      logger.info(`BrightData direct: ${toolName} — target returned no extractable content (deterministic)`);
      if (toolName === 'scrape_as_markdown') throw err;
      noteMiss(classifyDirectMiss(err));
      return null;
    }
    // Raw HTTP error (e.g. 403 from api.brightdata.com): the response BODY names the
    // exact reason (ip not in zone whitelist, zone disabled, bad token) and often the
    // offending source IP — it was previously dropped, keeping outages undiagnosable.
    const body = typeof err.response?.data === 'string'
      ? err.response.data.slice(0, 500).replace(/\s+/g, ' ').trim()
      : '';
    // Taxonomy (log-signal family 30dfad06, 2026-11-06): the catch-all is NOT
    // homogeneous. `classifyDirectMiss` already separates the dependency's
    // degradation (`http_5xx`, `net_*`) from classes that are OURS or
    // owner-actionable — a `http_401/402/403` revoked token or a disabled zone
    // is an outage we must still escalate (the 2026-08-06 invisible-outage
    // class), and `timeout` is our own budget firing. Tag ONLY the vendor's
    // 5xx/network failures logExternal; everything else stays an untagged warn
    // that files. Recall is preserved: the audit's vendor_transient rung reads
    // app_error_logs with no logClass filter, and every fall-through still
    // writes a web_fetch_path loop_metric row carrying directClass.
    const missClass = classifyDirectMiss(err).class;
    const vendorDegraded = /^http_5\d\d$/.test(missClass) || missClass.startsWith('net_');
    const failedMessage = `BrightData direct: ${toolName} failed: ${err.response?.status || ''} ${err.message}${body ? ` — body: ${body}` : ''}`;
    if (vendorDegraded) logExternal(failedMessage, { source: 'brightdata-direct', tool: toolName });
    else logger.warn(failedMessage, { source: 'brightdata-direct', tool: toolName });
    noteMiss(classifyDirectMiss(err));
    return null;
  }
}
