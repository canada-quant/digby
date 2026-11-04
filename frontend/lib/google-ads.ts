/**
 * The site's ONE Google tag: Google Analytics GA4 + Google Ads + the Sign-up conversion.
 *
 * - ONE gtag.js, site-wide: app/layout.tsx renders app/GoogleAdsTag.tsx on every page. It loads gtag.js by the GA4
 *   id exactly as Google's GA snippet does (`gtag/js?id=G-NK7XPHC7FE`, owner 2026-10-07: "here is the tag … which
 *   should have analytics attached") and configures two destinations on it: GA4 `G-NK7XPHC7FE` and Google Ads
 *   `AW-00000000000` — the Ads account (Digby.ai, 504-594-5009) that owns BOTH conversion actions:
 *     · "Page view (Page load digby.example.com)" — a URL rule kept in Google's own tag config for AW-00000000000 (no code);
 *     · "Sign-up" — the manual event reportGoogleAdsSignup() sends after a successful registration (app/login).
 *   The GA4 container does not carry the Ads destination, so the explicit `config` for AW-00000000000 is required.
 * - AW-11419212138 is GONE (owner 2026-10-07: "i think we need to remove the other 11419212138 tag"): it held no
 *   conversion action, it only added a second Ads account's page-view / remarketing hits.
 * - Never for a Digby Kids (child) session: the access token's `isChild` claim (set on child logins + refreshes —
 *   backend auth.service) keeps the tag from loading, and a child who signs in after it loaded as a visitor gets
 *   Google's per-id `ga-disable-<id>` flag (gtag stops sending for that id).
 * Kill switches (frontend BUILD args — docker-compose.app.yml → Dockerfile):
 *   NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=1 — no tag, no events (the master switch, GA4 included);
 *   NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=1 — the tag loads and configures the Ads id only (no GA4).
 * History: 2026-10-04 Ads tag + Sign-up (#1261, then two Ads ids); 2026-10-06 GA4 added (ticket 4bb5fe23).
 */
/** The Google Ads account (Digby.ai, 504-594-5009) that owns the Page view and Sign-up conversion actions. */
export const GOOGLE_ADS_ID = 'AW-00000000000';
export const GOOGLE_ADS_SIGNUP_SEND_TO = `${GOOGLE_ADS_ID}/cQctCLPgl5EdEKTwxsE9`;
/** Every Google Ads id the page configures — one account. */
export const GOOGLE_ADS_CONFIG_IDS: readonly string[] = [GOOGLE_ADS_ID];

/** Google Analytics GA4 measurement id (ticket 4bb5fe23) — a destination on the same gtag.js. */
export const GOOGLE_ANALYTICS_ID = 'G-NK7XPHC7FE';

export function googleAdsTagDisabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED === '1';
}

export function googleAnalyticsDisabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED === '1';
}

/** Every id the page's ONE gtag.js configures: GA4 (unless its kill switch is set), then the Google Ads account. */
export function googleTagConfigIds(): readonly string[] {
  return googleAnalyticsDisabled() ? GOOGLE_ADS_CONFIG_IDS : [GOOGLE_ANALYTICS_ID, ...GOOGLE_ADS_CONFIG_IDS];
}

/** The id gtag.js is loaded by — Google's GA snippet (`gtag/js?id=G-…`); the Ads id when GA4 is switched off. */
export function googleTagLoaderId(): string {
  return googleAnalyticsDisabled() ? GOOGLE_ADS_ID : GOOGLE_ANALYTICS_ID;
}

/** Every id a child session switches off — GA4 always included (the flag is a no-op for an unconfigured id). */
const GOOGLE_TAG_DISABLE_IDS: readonly string[] = [...GOOGLE_ADS_CONFIG_IDS, GOOGLE_ANALYTICS_ID];

/** The inline bootstrap from Google's snippet, plus one `config` per id (one library, several destinations). */
export function googleAdsBootstrap(ids: readonly string[] = googleTagConfigIds()): string {
  return [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){dataLayer.push(arguments);}',
    "gtag('js', new Date());",
    ...ids.map((id) => `gtag('config', '${id}');`),
  ].join('\n');
}

/** The `isChild` claim of a stored access token; null when there is no token, undefined when it cannot be read. */
export function tokenIsChild(token: string | null | undefined): boolean | null | undefined {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')) : '';
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims.isChild === true : undefined;
  } catch {
    return undefined;
  }
}

/** May this browser session carry the tag? A visitor (no token) or a readable adult token: yes. A child token, or a
 *  token that cannot be read: no (fail closed — the kid exclusion must never depend on a parse succeeding). */
export function googleAdsAllowedForToken(token: string | null | undefined): boolean {
  const child = tokenIsChild(token);
  return child === null || child === false;
}

/** Turn gtag off for every configured id — Ads AND GA4 (Google's documented per-id opt-out flag). */
export function disableGoogleAds(win: Record<string, unknown> | undefined = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>)): void {
  if (!win) return;
  for (const id of GOOGLE_TAG_DISABLE_IDS) win[`ga-disable-${id}`] = true;
}

type Gtag = (...args: unknown[]) => void;

/**
 * Report a completed sign-up — Google's "Sign-up conversion page" event snippet (Google Ads), then GA4's recommended
 * `sign_up` event (owner 2026-10-07: "yes add ga4 event as well"; mark it as a key event in GA4 to count it as a
 * conversion there). The GA4 event is scoped to G-NK7XPHC7FE with `send_to` and skipped under
 * NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=1. Safe anywhere: a no-op on the server, when the tag is disabled, or for a
 * session that may not carry it; queued in dataLayer when gtag.js has not loaded yet (delivered once it does).
 * Never throws.
 */
export function reportGoogleAdsSignup(win: (Window & { dataLayer?: unknown[]; gtag?: Gtag }) | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!win || googleAdsTagDisabled()) return;
  try {
    win.dataLayer = win.dataLayer || [];
    const gtag: Gtag = typeof win.gtag === 'function'
      ? win.gtag
      // eslint-disable-next-line prefer-rest-params
      : function gtag() { (win.dataLayer as unknown[]).push(arguments); };
    gtag('event', 'conversion', { send_to: GOOGLE_ADS_SIGNUP_SEND_TO, value: 1.0, currency: 'USD' });
    if (!googleAnalyticsDisabled()) gtag('event', 'sign_up', { method: 'email', send_to: GOOGLE_ANALYTICS_ID });
  } catch { /* tracking never breaks sign-up */ }
}
