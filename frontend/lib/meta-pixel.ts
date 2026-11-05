/**
 * Meta Pixel (owner 2026-10-07: the "Meta Pixel Code" snippet for pixel 4660227547545860) + the sign-up event.
 *
 * - ONE pixel, site-wide: app/layout.tsx renders app/MetaPixel.tsx on every page; its bootstrap is Meta's snippet
 *   verbatim (fbevents.js loader, `fbq('init', …)`, `fbq('track', 'PageView')`). The snippet's <noscript> image is
 *   left out — the app does not run without JavaScript, and the image could not honour the Digby Kids rule below.
 * - Never for a Digby Kids (child) session — the SAME rule as the Google tag (lib/google-ads.ts
 *   googleAdsAllowedForToken): a visitor or a readable adult token loads it, a child or unreadable token does not, and
 *   a child who signs in after it loaded as a visitor gets `fbq('consent', 'revoke')` (Meta stops sending).
 * - reportMetaSignup(eventId) sends `CompleteRegistration` after a successful registration (app/login) with an
 *   `eventID`; the same id rides the register request (`metaEventId`) so the backend's Conversions API event
 *   (backend/src/modules/auth/meta-capi.ts) is deduplicated with it — Meta counts the sign-up once.
 * Kill switch NEXT_PUBLIC_META_PIXEL_DISABLED=1 (frontend BUILD arg — docker-compose.app.yml → Dockerfile): no pixel,
 * no browser events (the server event is gated separately: META_CAPI_DISABLED / META_CAPI_ACCESS_TOKEN).
 */
export const META_PIXEL_ID = '4660227547545860';

export function metaPixelDisabled(): boolean {
  return process.env.NEXT_PUBLIC_META_PIXEL_DISABLED === '1';
}

/** Meta's base code, verbatim (minus the <noscript> image). */
export function metaPixelBootstrap(pixelId: string = META_PIXEL_ID): string {
  return [
    '!function(f,b,e,v,n,t,s)',
    '{if(f.fbq)return;n=f.fbq=function(){n.callMethod?',
    'n.callMethod.apply(n,arguments):n.queue.push(arguments)};',
    "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';",
    'n.queue=[];t=b.createElement(e);t.async=!0;',
    't.src=v;s=b.getElementsByTagName(e)[0];',
    "s.parentNode.insertBefore(t,s)}(window, document,'script',",
    "'https://connect.facebook.net/en_US/fbevents.js');",
    `fbq('init', '${pixelId}');`,
    "fbq('track', 'PageView');",
  ].join('\n');
}

type Fbq = (...args: unknown[]) => void;
type FbqWindow = { fbq?: Fbq };

/** Stop the pixel sending for the rest of the visit (a child session signed in after it loaded). */
export function disableMetaPixel(win: FbqWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as FbqWindow)): void {
  try {
    if (win && typeof win.fbq === 'function') win.fbq('consent', 'revoke');
  } catch { /* tracking never breaks the app */ }
}

/** A fresh event id shared by the browser event and the server (Conversions API) event for deduplication. */
export function newMetaEventId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Report a completed sign-up to the Meta Pixel — `CompleteRegistration` with the shared event id. A no-op on the
 * server, when the pixel is disabled, or when it never loaded (a child session; the server event still counts).
 * Never throws.
 */
export function reportMetaSignup(eventId: string, win: FbqWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as FbqWindow)): void {
  if (!win || metaPixelDisabled() || typeof win.fbq !== 'function') return;
  try {
    win.fbq('track', 'CompleteRegistration', {}, { eventID: eventId });
  } catch { /* tracking never breaks sign-up */ }
}

// ── Meta ClickID (fbc) ─────────────────────────────────────────────────────
// Owner 2026-10-08 (Events Manager: "Send Meta ClickID to improve conversion reporting" — 0% of CompleteRegistration
// events carried it). Meta's own script writes `_fbc` from ?fbclid, but only when it loads — an ad blocker, a slow
// network or Safari's script limits leave the cookie unwritten. We write it OURSELVES from the landing URL (Meta's
// documented format fb.1.<creation ms>.<fbclid>, on the registrable domain so Meta's script reads the same cookie)
// and send it with the sign-up; the backend also rebuilds it from our first-party fbclid capture (meta-capi chooseFbc).

const FBC_COOKIE = '_fbc';
const FBC_MAX_AGE_S = 90 * 24 * 3600;
const FBCLID_RE = /^[A-Za-z0-9_-]{8,500}$/;

function readCookie(doc: { cookie: string }, name: string): string | null {
  const hit = doc.cookie.split(/;\s*/).find(c => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/** The fbc value a landing URL's ?fbclid makes, or null. */
export function fbcFromSearch(search: string, nowMs: number = Date.now()): string | null {
  const fbclid = new URLSearchParams(search).get('fbclid');
  return fbclid && FBCLID_RE.test(fbclid) ? `fb.1.${nowMs}.${fbclid}` : null;
}

/** Write `_fbc` from ?fbclid when the cookie is missing or names a different click. Never throws. */
export function persistFbcFromUrl(
  win: { location: { search: string; hostname: string; protocol: string }; document: { cookie: string } } | undefined =
    typeof window === 'undefined' ? undefined : window,
  nowMs: number = Date.now(),
): string | null {
  try {
    if (!win) return null;
    const fbc = fbcFromSearch(win.location.search, nowMs);
    if (!fbc) return null;
    const fbclid = fbc.split('.').slice(3).join('.');
    const existing = readCookie(win.document, FBC_COOKIE);
    if (existing && existing.endsWith(`.${fbclid}`)) return existing;
    const host = win.location.hostname;
    const domain = /(^|\.)digby\.ai$/.test(host) ? '; Domain=.digby.ai' : '';
    const secure = win.location.protocol === 'https:' ? '; Secure' : '';
    win.document.cookie = `${FBC_COOKIE}=${fbc}; Max-Age=${FBC_MAX_AGE_S}; Path=/; SameSite=Lax${domain}${secure}`;
    return fbc;
  } catch { return null; }
}

/** The `_fbc` cookie this browser carries (sent with the sign-up as `metaFbc`), or undefined. */
export function currentFbc(doc: { cookie: string } | undefined = typeof document === 'undefined' ? undefined : document): string | undefined {
  try { return (doc && readCookie(doc, FBC_COOKIE)) || undefined; } catch { return undefined; }
}
