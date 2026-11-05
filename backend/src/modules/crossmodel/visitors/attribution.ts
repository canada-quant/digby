/**
 * Traffic-source attribution — pure leaf (owner 2026-10-07: "from what traffic source ie google ads facebook").
 *
 * A TOUCH is what one landing carried: the utm_* tags, the ad-network click ids, the referrer HOST (never the full
 * referrer URL) and the landing PATH (normalized — no query string, ids collapsed). The web client builds the same
 * shape (frontend/lib/visitor-analytics.ts) and the server re-sanitizes + re-classifies it here — the client's own
 * channel label is never trusted.
 *
 * classifyChannel is deterministic, first match wins:
 *   1. click ids: gclid / gbraid / wbraid → google_ads · fbclid → facebook_ads · msclkid → bing_ads ·
 *      ttclid → tiktok_ads · li_fat_id → linkedin_ads
 *   2. utm with a PAID medium (cpc, ppc, paid*, cpm, display, …): by utm_source → google_ads / facebook_ads
 *      (facebook, fb, meta, instagram, ig) / bing_ads / tiktok_ads / linkedin_ads / other_paid
 *   3. utm_medium email / newsletter → email · social → social_organic · organic → organic_search ·
 *      referral → referral; any other utm tag → by its source (a search engine → organic_search, a social network
 *      → social_organic) else other_campaign
 *   4. referrer host: a search engine → organic_search · a social network → social_organic · webmail → email ·
 *      Digby's own hosts → ignored (internal navigation) · anything else → referral
 *   5. nothing → direct
 */

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'] as const;

export type UtmKey = typeof UTM_KEYS[number];
export type ClickIdKey = typeof CLICK_ID_KEYS[number];

export interface Touch {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  msclkid?: string;
  ttclid?: string;
  li_fat_id?: string;
  /** the referrer's HOST only (lower-case, no www.) */
  referrer?: string;
  /** the landing path (normalizePath) */
  landing?: string;
  /** when the touch happened (ms epoch, client clock) */
  ts?: number;
}

export const CHANNELS = [
  'google_ads', 'facebook_ads', 'bing_ads', 'tiktok_ads', 'linkedin_ads', 'other_paid',
  'organic_search', 'social_organic', 'email', 'referral', 'other_campaign', 'direct',
] as const;
export type Channel = typeof CHANNELS[number];

/** Paid channels — the ones an ad budget buys. */
export const PAID_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['google_ads', 'facebook_ads', 'bing_ads', 'tiktok_ads', 'linkedin_ads', 'other_paid']);

/** Hosts that are Digby itself — a referrer from one of these is internal navigation, not a source. */
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

const MAX_VALUE = 200;

function clean(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_VALUE);
  return s || undefined;
}

/** A referrer value → its host (lower-case, no leading www.), or undefined. Accepts a full URL or a bare host. */
export function referrerHost(raw: unknown): string | undefined {
  const s = clean(raw);
  if (!s) return undefined;
  let host = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { host = new URL(s).hostname; } catch { return undefined; }
  } else {
    host = s.split(/[/?#]/)[0];
  }
  host = host.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const ok = (/^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.')) || host === 'localhost';
  return ok ? host : undefined;
}

/** Is this host Digby itself (internal navigation)? */
export function isOwnHost(host: string | undefined): boolean {
  return !!host && OWN_HOST_RE.test(host);
}

const UUID_SEG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_SEG_RE = /^[A-Za-z0-9_-]{20,}$/;
const NUM_SEG_RE = /^\d{3,}$/;

/**
 * A page path for analytics: no query string / hash (they can carry tokens or text), every id-like segment
 * collapsed (uuid → :id, long token → :token, long number → :n), ≤ 200 chars. `/crossmodel/shared/abc…` →
 * `/crossmodel/shared/:token`. Never throws; '' / junk → '/'.
 */
export function normalizePath(raw: unknown): string {
  const s = clean(raw) ?? '/';
  let path = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { path = new URL(s).pathname; } catch { path = '/'; }
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

/** Server-side sanitizer: only the known keys, trimmed strings ≤ 200 chars, referrer → host, landing → path. */
export function sanitizeTouch(raw: unknown, now: number = Date.now()): Touch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const t: Touch = {};
  for (const k of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
    const v = clean(r[k]);
    if (v) t[k] = v;
  }
  const ref = referrerHost(r.referrer);
  if (ref) t.referrer = ref;
  if (r.landing !== undefined && r.landing !== null && r.landing !== '') t.landing = normalizePath(r.landing);
  const ts = Number(r.ts);
  if (Number.isFinite(ts) && ts > 0) t.ts = Math.min(Math.max(Math.floor(ts), now - 400 * 86_400_000), now);
  return Object.keys(t).length ? t : null;
}

/** Does the touch carry a SOURCE (a utm tag, a click id or an external referrer)? A plain direct visit does not. */
export function hasSource(t: Touch | null | undefined): boolean {
  if (!t) return false;
  if (UTM_KEYS.some((k) => !!t[k]) || CLICK_ID_KEYS.some((k) => !!t[k])) return true;
  return !!t.referrer && !isOwnHost(t.referrer);
}

function lc(v: string | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

function paidChannelForSource(source: string): Channel {
  if (GOOGLE_SOURCE_RE.test(source)) return 'google_ads';
  if (FACEBOOK_SOURCE_RE.test(source)) return 'facebook_ads';
  if (BING_SOURCE_RE.test(source)) return 'bing_ads';
  if (TIKTOK_SOURCE_RE.test(source)) return 'tiktok_ads';
  if (LINKEDIN_SOURCE_RE.test(source)) return 'linkedin_ads';
  return 'other_paid';
}

/** The deterministic channel of one touch (see the header for the rule table). */
export function classifyChannel(t: Touch | null | undefined): Channel {
  if (!t) return 'direct';
  // 1. ad-network click ids — the strongest signal
  if (t.gclid || t.gbraid || t.wbraid) return 'google_ads';
  if (t.fbclid) return 'facebook_ads';
  if (t.msclkid) return 'bing_ads';
  if (t.ttclid) return 'tiktok_ads';
  if (t.li_fat_id) return 'linkedin_ads';
  const medium = lc(t.utm_medium);
  const source = lc(t.utm_source);
  const tagged = UTM_KEYS.some((k) => !!t[k]);
  if (tagged) {
    // 2. paid utm
    if (medium && PAID_MEDIUM_RE.test(medium)) return paidChannelForSource(source);
    // 3. other utm mediums
    if (/^(e-?mail|newsletter|mailchimp|email_campaign)$/.test(medium) || /e-?mail/.test(medium)) return 'email';
    if (/^(social|social[-_ ]?network|social[-_ ]?media|sm|organic[-_ ]?social)$/.test(medium)) return 'social_organic';
    if (/^organic$/.test(medium)) return SOCIAL_SOURCE_RE.test(source) && !SEARCH_SOURCE_RE.test(source) ? 'social_organic' : 'organic_search';
    if (/^referral$/.test(medium)) return 'referral';
    if (SEARCH_SOURCE_RE.test(source)) return 'organic_search';
    if (SOCIAL_SOURCE_RE.test(source)) return 'social_organic';
    if (/^(e-?mail|newsletter)$/.test(source)) return 'email';
    return 'other_campaign';
  }
  // 4. referrer host
  const host = t.referrer;
  if (host && !isOwnHost(host)) {
    if (WEBMAIL_HOST_RE.test(host)) return 'email';
    if (SEARCH_HOST_RE.test(host)) return 'organic_search';
    if (SOCIAL_HOST_RE.test(host)) return 'social_organic';
    return 'referral';
  }
  // 5. nothing
  return 'direct';
}

/** The campaign label of a touch (utm_campaign), or null — a gclid-only landing has no campaign name in the URL. */
export function campaignOf(t: Touch | null | undefined): string | null {
  return t?.utm_campaign ? t.utm_campaign : null;
}

/** Human labels for the admin UI (the frontend keeps its own copy; this one serves server-rendered summaries). */
export const CHANNEL_LABELS: Record<Channel | 'unknown' | 'unattributed', string> = {
  google_ads: 'Google Ads',
  facebook_ads: 'Facebook / Instagram Ads',
  bing_ads: 'Microsoft (Bing) Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  other_paid: 'Other paid',
  organic_search: 'Organic search',
  social_organic: 'Social (organic)',
  email: 'Email',
  referral: 'Referral',
  other_campaign: 'Other campaign',
  direct: 'Direct',
  unknown: 'Unknown (no visitor record)',
  unattributed: 'Unattributed',
};
