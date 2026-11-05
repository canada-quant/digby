/**
 * First-party visitor analytics — the web CAPTURE (owner 2026-10-07: "i need a way to see activity on users/api
 * cost/ ip addressed or unique hash for users that use digby from what traffic source ie google ads facebook and
 * the user flow").
 *
 * - On every LANDING (a full page load) it reads the utm_* tags, the ad click ids (gclid / gbraid / wbraid — Google
 *   Ads, fbclid — Facebook / Meta, msclkid, ttclid, li_fat_id), the referrer HOST and the landing path. It keeps a
 *   FIRST touch (written once, never overwritten) and a LAST touch (the latest landing that carried a source) in a
 *   first-party cookie + localStorage, plus a random visitor id (`dg_vid`, uuid, 13 months).
 * - Page views and funnel steps (signup_view, login_view, signup_complete, login, chat_sent, …) are queued and sent
 *   in batches to POST /api/crossmodel/visit-events (fetch keepalive; sendBeacon when the page hides). The server
 *   re-sanitizes and re-classifies everything (backend/src/modules/crossmodel/visitors/) — classifyChannel here is
 *   the same deterministic table, kept for the client's own reads and pinned by the same test cases.
 * - NEVER for a Digby Kids session: the same gate as the Google tag (lib/google-ads.ts googleAdsAllowedForToken —
 *   the access token's isChild claim, fail-CLOSED on an unreadable token), re-read on every event; a session that
 *   turns out to be a child erases the visitor id, both touches and the queue.
 * Kill switch: NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=1 (frontend BUILD arg) — no capture, no requests, no header.
 * The server has its own: VISITOR_ANALYTICS_DISABLED=1 (204, nothing stored). Never throws.
 */
import { googleAdsAllowedForToken } from './google-ads';

export const VISITOR_KEY = 'dg_vid';
export const FIRST_TOUCH_KEY = 'dg_ft';
export const LAST_TOUCH_KEY = 'dg_lt';
/** 13 months. */
export const VISITOR_COOKIE_MAX_AGE_S = 395 * 24 * 3600;
export const VISIT_EVENTS_ENDPOINT = '/api/crossmodel/visit-events';
export const VISITOR_HEADER = 'X-Digby-Visitor';
export const FLUSH_DELAY_MS = 3_000;
export const MAX_BATCH = 50;
const MAX_QUEUE = 200;
const TOUCH_VALUE_MAX = 150;

export function visitorAnalyticsDisabled(): boolean {
  return process.env.NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED === '1';
}

// ── attribution (mirrors backend visitors/attribution.ts) ────────────────────

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'] as const;

export interface Touch {
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string;
  gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string; msclkid?: string; ttclid?: string; li_fat_id?: string;
  referrer?: string;
  landing?: string;
  ts?: number;
}

export type Channel =
  | 'google_ads' | 'facebook_ads' | 'bing_ads' | 'tiktok_ads' | 'linkedin_ads' | 'other_paid'
  | 'organic_search' | 'social_organic' | 'email' | 'referral' | 'other_campaign' | 'direct';

const OWN_HOST_RE = /(^|\.)digby\.ai$|^localhost$|^127\.0\.0\.1$/;
const SEARCH_HOST_RE = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.[a-z.]+|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|seznam\.cz|kagi\.com)$/;
const SOCIAL_HOST_RE = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|messenger\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|reddit\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|threads\.net|bsky\.app|tumblr\.com|snapchat\.com|whatsapp\.com|discord\.com|news\.ycombinator\.com|quora\.com|mastodon\.social)$/;
const WEBMAIL_HOST_RE = /^(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.proton\.me|app\.fastmail\.com|mail\.aol\.com)$/;
const PAID_MEDIUM_RE = /^(cpc|ppc|cpm|cpv|cpa|cpp|paid|paidsearch|paid[-_ ]?search|paidsocial|paid[-_ ]?social|display|banner|ads?|sem|retargeting|remarketing|sponsored|pmax)$|paid|cpc/;
const GOOGLE_SOURCE_RE = /^(google|googleads|google[-_ ]?ads|adwords|google_adwords|youtube|gdn|pmax)$/;
const FACEBOOK_SOURCE_RE = /^(facebook|fb|meta|instagram|ig|messenger|facebook[-_ ]?ads|meta[-_ ]?ads|an)$/;
const BING_SOURCE_RE = /^(bing|microsoft|msn|bing[-_ ]?ads|microsoft[-_ ]?ads)$/;
const TIKTOK_SOURCE_RE = /^(tiktok|tik[-_ ]?tok|tiktok[-_ ]?ads)$/;
const LINKEDIN_SOURCE_RE = /^(linkedin|lnkd|linkedin[-_ ]?ads)$/;
const SEARCH_SOURCE_RE = /^(google|bing|duckduckgo|ddg|yahoo|yandex|baidu|ecosia|brave|startpage|qwant|naver|kagi)$/;
const SOCIAL_SOURCE_RE = /^(facebook|fb|meta|instagram|ig|twitter|x|t\.co|linkedin|reddit|youtube|tiktok|pinterest|threads|bluesky|bsky|tumblr|snapchat|whatsapp|discord|hackernews|hn|quora|mastodon)$/;

export function isOwnHost(host: string | undefined): boolean {
  return !!host && OWN_HOST_RE.test(host);
}

/** A referrer URL → its host (lower-case, no www.), or undefined. */
export function referrerHost(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Does the touch carry a source (a utm tag, a click id or an external referrer)? */
export function hasSource(t: Touch | null | undefined): boolean {
  if (!t) return false;
  if (UTM_KEYS.some((k) => !!t[k]) || CLICK_ID_KEYS.some((k) => !!t[k])) return true;
  return !!t.referrer && !isOwnHost(t.referrer);
}

/** The deterministic channel of one touch — the same table as the server's classifyChannel. */
export function classifyChannel(t: Touch | null | undefined): Channel {
  if (!t) return 'direct';
  if (t.gclid || t.gbraid || t.wbraid) return 'google_ads';
  if (t.fbclid) return 'facebook_ads';
  if (t.msclkid) return 'bing_ads';
  if (t.ttclid) return 'tiktok_ads';
  if (t.li_fat_id) return 'linkedin_ads';
  const medium = (t.utm_medium ?? '').trim().toLowerCase();
  const source = (t.utm_source ?? '').trim().toLowerCase();
  if (UTM_KEYS.some((k) => !!t[k])) {
    if (medium && PAID_MEDIUM_RE.test(medium)) {
      if (GOOGLE_SOURCE_RE.test(source)) return 'google_ads';
      if (FACEBOOK_SOURCE_RE.test(source)) return 'facebook_ads';
      if (BING_SOURCE_RE.test(source)) return 'bing_ads';
      if (TIKTOK_SOURCE_RE.test(source)) return 'tiktok_ads';
      if (LINKEDIN_SOURCE_RE.test(source)) return 'linkedin_ads';
      return 'other_paid';
    }
    if (/^(e-?mail|newsletter|mailchimp|email_campaign)$/.test(medium) || /e-?mail/.test(medium)) return 'email';
    if (/^(social|social[-_ ]?network|social[-_ ]?media|sm|organic[-_ ]?social)$/.test(medium)) return 'social_organic';
    if (/^organic$/.test(medium)) return SOCIAL_SOURCE_RE.test(source) && !SEARCH_SOURCE_RE.test(source) ? 'social_organic' : 'organic_search';
    if (/^referral$/.test(medium)) return 'referral';
    if (SEARCH_SOURCE_RE.test(source)) return 'organic_search';
    if (SOCIAL_SOURCE_RE.test(source)) return 'social_organic';
    if (/^(e-?mail|newsletter)$/.test(source)) return 'email';
    return 'other_campaign';
  }
  const host = t.referrer;
  if (host && !isOwnHost(host)) {
    if (WEBMAIL_HOST_RE.test(host)) return 'email';
    if (SEARCH_HOST_RE.test(host)) return 'organic_search';
    if (SOCIAL_HOST_RE.test(host)) return 'social_organic';
    return 'referral';
  }
  return 'direct';
}

const UUID_SEG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_SEG_RE = /^[A-Za-z0-9_-]{20,}$/;
const NUM_SEG_RE = /^\d{3,}$/;

/** An analytics path: no query string / hash, id-like segments collapsed (:id / :token / :n), ≤ 200 chars. */
export function normalizePath(raw: string | null | undefined): string {
  let path = String(raw ?? '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { path = '/'; }
  }
  path = path.split(/[?#]/)[0] || '/';
  const segs = path.split('/').filter(Boolean).slice(0, 12).map((seg) => {
    let d = seg;
    try { d = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (UUID_SEG_RE.test(d)) return ':id';
    if (TOKEN_SEG_RE.test(d) && /\d/.test(d)) return ':token';
    if (NUM_SEG_RE.test(d)) return ':n';
    return d.replace(/[^A-Za-z0-9._~:@!$&'()*+,;=-]/g, '').slice(0, 60) || ':x';
  });
  return ('/' + segs.join('/')).slice(0, 200);
}

/** The touch one landing carries (href + document.referrer). Internal referrers are dropped. */
export function readTouch(href: string, referrer: string | null | undefined, now: number): Touch {
  const t: Touch = { ts: now };
  try {
    const url = new URL(href);
    for (const k of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
      const v = url.searchParams.get(k);
      if (v && v.trim()) t[k] = v.trim().slice(0, TOUCH_VALUE_MAX);
    }
    t.landing = normalizePath(url.pathname);
  } catch {
    t.landing = '/';
  }
  const host = referrerHost(referrer);
  if (host && !isOwnHost(host)) t.referrer = host;
  return t;
}

// ── the capture ──────────────────────────────────────────────────────────────

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export interface CaptureEnv {
  href(): string;
  referrer(): string;
  getCookie(name: string): string | null;
  setCookie(name: string, value: string, maxAgeS: number): void;
  deleteCookie(name: string): void;
  storage: KV | null;
  /** the stored access token (kid gate + Bearer), or null */
  token(): string | null;
  sendBeacon?: (url: string, data: Blob | string) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  now(): number;
  uuid(): string;
  webdriver?: boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

export interface QueuedEvent { type: string; path: string; ts: number; props?: Record<string, string | number | boolean | null> }

export interface VisitorCapture {
  /** process this page load's landing (first / last touch). Idempotent per capture instance. */
  land(): void;
  track(type: string, props?: QueuedEvent['props'], path?: string, opts?: { flush?: boolean }): void;
  flush(opts?: { beacon?: boolean }): void;
  /** the visitor id when capture is allowed (never creates one), else null */
  visitorId(): string | null;
  /** erase the visitor id, both touches and the queue (Digby Kids / opt-out) */
  forget(): void;
  /** test hook */
  readonly queue: QueuedEvent[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(raw: string | null): Touch | null {
  if (!raw) return null;
  try {
    let s = raw;
    try { s = decodeURIComponent(raw); } catch { /* plain */ }
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Touch) : null;
  } catch {
    return null;
  }
}

export function createVisitorCapture(env: CaptureEnv): VisitorCapture {
  const queue: QueuedEvent[] = [];
  let landed = false;
  let timer: unknown = null;

  const allowed = (): boolean => !visitorAnalyticsDisabled() && googleAdsAllowedForToken(env.token());

  const get = (key: string): string | null => {
    let v: string | null = null;
    try { v = env.getCookie(key); } catch { /* blocked */ }
    if (!v) { try { v = env.storage?.getItem(key) ?? null; } catch { /* blocked */ } }
    return v;
  };
  const put = (key: string, value: string): void => {
    try { env.setCookie(key, value, VISITOR_COOKIE_MAX_AGE_S); } catch { /* blocked */ }
    try { env.storage?.setItem(key, value); } catch { /* blocked */ }
  };
  const del = (key: string): void => {
    try { env.deleteCookie(key); } catch { /* blocked */ }
    try { env.storage?.removeItem(key); } catch { /* blocked */ }
  };

  const ensureId = (): string => {
    const existing = get(VISITOR_KEY);
    if (existing && UUID_RE.test(existing)) {
      // heal whichever store lost it (a cleared cookie, a fresh localStorage)
      if (!safe(() => env.getCookie(VISITOR_KEY))) safe(() => env.setCookie(VISITOR_KEY, existing, VISITOR_COOKIE_MAX_AGE_S));
      if (!safe(() => env.storage?.getItem(VISITOR_KEY) ?? null)) safe(() => env.storage?.setItem(VISITOR_KEY, existing));
      return existing.toLowerCase();
    }
    const id = env.uuid().toLowerCase();
    put(VISITOR_KEY, id);
    return id;
  };

  const forget = (): void => {
    queue.length = 0;
    if (timer !== null) { safe(() => env.clearTimer(timer)); timer = null; }
    for (const k of [VISITOR_KEY, FIRST_TOUCH_KEY, LAST_TOUCH_KEY]) del(k);
  };

  const land = (): void => {
    if (landed) return;
    landed = true;
    if (!allowed()) { forget(); return; }
    ensureId();
    const touch = readTouch(env.href(), env.referrer(), env.now());
    if (!readJson(get(FIRST_TOUCH_KEY))) put(FIRST_TOUCH_KEY, encodeURIComponent(JSON.stringify(touch)));
    if (hasSource(touch)) put(LAST_TOUCH_KEY, encodeURIComponent(JSON.stringify(touch)));
  };

  const flush = (opts?: { beacon?: boolean }): void => {
    if (timer !== null) { safe(() => env.clearTimer(timer)); timer = null; }
    if (!queue.length) return;
    if (!allowed()) { forget(); return; }
    const visitorId = ensureId();
    const attribution = { first: readJson(get(FIRST_TOUCH_KEY)), last: readJson(get(LAST_TOUCH_KEY)) };
    while (queue.length) {
      const events = queue.splice(0, MAX_BATCH);
      const body = JSON.stringify({ visitorId, events, attribution, ...(env.webdriver ? { webdriver: true } : {}) });
      let sent = false;
      if (opts?.beacon && env.sendBeacon) {
        try {
          const data = typeof Blob === 'function' ? new Blob([body], { type: 'text/plain;charset=UTF-8' }) : body;
          sent = env.sendBeacon(VISIT_EVENTS_ENDPOINT, data);
        } catch { sent = false; }
      }
      if (!sent && env.fetch) {
        const token = safe(() => env.token());
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        try {
          void Promise.resolve(env.fetch(VISIT_EVENTS_ENDPOINT, { method: 'POST', headers, body, keepalive: true, credentials: 'same-origin' })).catch(() => undefined);
        } catch { /* analytics never breaks the page */ }
      }
    }
  };

  const track: VisitorCapture['track'] = (type, props, path, opts) => {
    if (!allowed()) { forget(); return; }
    if (!landed) land();
    let p = path;
    if (p === undefined) { try { p = new URL(env.href()).pathname; } catch { p = '/'; } }
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ type, path: normalizePath(p), ts: env.now(), ...(props && Object.keys(props).length ? { props } : {}) });
    if (opts?.flush || queue.length >= 20) { flush(); return; }
    if (timer === null) timer = safe(() => env.setTimer(() => { timer = null; flush(); }, FLUSH_DELAY_MS)) ?? null;
  };

  const visitorId = (): string | null => {
    if (!allowed()) return null;
    const v = get(VISITOR_KEY);
    return v && UUID_RE.test(v) ? v.toLowerCase() : null;
  };

  return { land, track, flush, visitorId, forget, queue };
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

// ── the browser singleton ────────────────────────────────────────────────────

function cookieGet(name: string): string | null {
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? m.slice(name.length + 1) : null;
}

function cookieAttrs(): string {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  return `; Path=/; SameSite=Lax${secure}`;
}

/** The real-browser environment, or null on the server. */
export function browserEnv(): CaptureEnv | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  let storage: KV | null = null;
  try { storage = window.localStorage; } catch { storage = null; }
  return {
    href: () => window.location.href,
    referrer: () => document.referrer || '',
    getCookie: cookieGet,
    setCookie: (name, value, maxAgeS) => { document.cookie = `${name}=${value}; Max-Age=${maxAgeS}${cookieAttrs()}`; },
    deleteCookie: (name) => { document.cookie = `${name}=; Max-Age=0${cookieAttrs()}`; },
    storage,
    token: () => { try { return window.localStorage.getItem('accessToken'); } catch { return null; } },
    sendBeacon: typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? (u, d) => navigator.sendBeacon(u, d) : undefined,
    fetch: typeof window.fetch === 'function' ? (u, i) => window.fetch(u, i) : undefined,
    now: () => Date.now(),
    uuid: () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); })),
    webdriver: typeof navigator !== 'undefined' && (navigator as Navigator & { webdriver?: boolean }).webdriver === true,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (t) => window.clearTimeout(t as number),
  };
}

let singleton: VisitorCapture | null = null;

/** The page's capture (null on the server or when the build switch is set). */
export function visitorCapture(): VisitorCapture | null {
  if (visitorAnalyticsDisabled()) return null;
  if (singleton) return singleton;
  const env = browserEnv();
  if (!env) return null;
  singleton = createVisitorCapture(env);
  return singleton;
}

/** Record one funnel step from anywhere in the app. Safe everywhere; never throws. */
export function trackVisitEvent(type: string, props?: QueuedEvent['props'], opts?: { flush?: boolean }): void {
  try { visitorCapture()?.track(type, props, undefined, opts); } catch { /* never breaks the page */ }
}

/** The X-Digby-Visitor header value for API requests (stitching), or null. */
export function visitorIdForHeader(): string | null {
  try { return visitorCapture()?.visitorId() ?? null; } catch { return null; }
}

/** Tests only. */
export function __resetVisitorCaptureForTest(): void {
  singleton = null;
}
