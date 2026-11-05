/**
 * Google Ads tag + Sign-up conversion (owner 2026-10-04) — the snippet, both ids, the conversion event, the Digby
 * Kids exclusion, the kill switch, and where it mounts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  GOOGLE_ADS_CONFIG_IDS, GOOGLE_ADS_ID, GOOGLE_ADS_SIGNUP_SEND_TO, GOOGLE_ANALYTICS_ID, disableGoogleAds, googleAdsAllowedForToken,
  googleAdsBootstrap, googleTagConfigIds, googleTagLoaderId, reportGoogleAdsSignup, tokenIsChild,
} from './google-ads';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;

describe('google-ads', () => {
  afterEach(() => { delete process.env.NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED; });

  it('the bootstrap is Google\'s snippet, configuring the ONE Ads account that owns the conversions (owner 2026-10-07)', () => {
    expect(GOOGLE_ADS_ID).toBe('AW-16512038948');
    expect(GOOGLE_ADS_SIGNUP_SEND_TO).toBe('AW-16512038948/cQctCLPgl5EdEKTwxsE9');
    expect(GOOGLE_ADS_CONFIG_IDS).toEqual(['AW-16512038948']);
    const b = googleAdsBootstrap();
    expect(b).toContain('window.dataLayer = window.dataLayer || [];');
    expect(b).toContain('function gtag(){dataLayer.push(arguments);}');
    expect(b).toContain("gtag('js', new Date());");
    expect(b).toContain("gtag('config', 'AW-16512038948');");
    // AW-11419212138 is removed everywhere (owner 2026-10-07) — it held no conversion action.
    expect(b).not.toContain('11419212138');
    expect(frontendSources().filter((f) => /['"`]AW-11419212138/.test(f.text)).map((f) => f.rel)).toEqual([]); // no code literal
  });

  it('a sign-up sends Google\'s Ads conversion verbatim, then GA4\'s sign_up event (queued until gtag.js loads)', () => {
    const win: any = {};
    reportGoogleAdsSignup(win);
    expect(win.dataLayer).toHaveLength(2);
    expect(Array.from(win.dataLayer[0])).toEqual(['event', 'conversion', { send_to: 'AW-16512038948/cQctCLPgl5EdEKTwxsE9', value: 1.0, currency: 'USD' }]);
    expect(Array.from(win.dataLayer[1])).toEqual(['event', 'sign_up', { method: 'email', send_to: 'G-NK7XPHC7FE' }]);
  });

  it('uses the page\'s gtag when it exists', () => {
    const calls: unknown[][] = [];
    reportGoogleAdsSignup({ dataLayer: [], gtag: (...a: unknown[]) => calls.push(a) } as any);
    expect(calls).toEqual([
      ['event', 'conversion', { send_to: GOOGLE_ADS_SIGNUP_SEND_TO, value: 1.0, currency: 'USD' }],
      ['event', 'sign_up', { method: 'email', send_to: GOOGLE_ANALYTICS_ID }],
    ]);
  });

  it('NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=1 keeps the Ads conversion and drops the GA4 sign_up event', () => {
    process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED = '1';
    try {
      const calls: unknown[][] = [];
      reportGoogleAdsSignup({ dataLayer: [], gtag: (...a: unknown[]) => calls.push(a) } as any);
      expect(calls).toEqual([['event', 'conversion', { send_to: GOOGLE_ADS_SIGNUP_SEND_TO, value: 1.0, currency: 'USD' }]]);
    } finally { delete process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED; }
  });

  it('NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=1 sends nothing; no window is a no-op', () => {
    process.env.NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED = '1';
    const win: any = {};
    reportGoogleAdsSignup(win);
    expect(win.dataLayer).toBeUndefined();
    expect(() => reportGoogleAdsSignup(undefined)).not.toThrow();
  });

  it('Digby Kids never carry the tag: a child token, or one that cannot be read, is refused', () => {
    expect(tokenIsChild(null)).toBeNull();
    expect(tokenIsChild(jwt({ userId: 'u', isChild: true }))).toBe(true);
    expect(tokenIsChild(jwt({ userId: 'u', role: 'user' }))).toBe(false);
    expect(googleAdsAllowedForToken(null)).toBe(true);                                   // a visitor
    expect(googleAdsAllowedForToken(jwt({ userId: 'u', role: 'user' }))).toBe(true);      // an adult
    expect(googleAdsAllowedForToken(jwt({ userId: 'k', isChild: true }))).toBe(false);    // a child
    expect(googleAdsAllowedForToken('garbage')).toBe(false);                              // unreadable → closed
  });

  it('a child session that signs in after the tag loaded switches every id off', () => {
    const win: Record<string, unknown> = {};
    disableGoogleAds(win);
    expect(win['ga-disable-AW-16512038948']).toBe(true);
    expect(win['ga-disable-G-NK7XPHC7FE']).toBe(true);
  });

  it('ONE tag, site-wide: the root layout renders it; no page adds a second; sign-up fires the conversion', () => {
    expect(src('../app/layout.tsx')).toContain('<GoogleAdsTag />');
    const tag = src('../app/GoogleAdsTag.tsx');
    expect(tag).toContain('https://www.googletagmanager.com/gtag/js?id=${googleTagLoaderId()}');
    expect(tag).toContain('googleAdsAllowedForToken(storedToken())');
    expect(src('../app/crossmodel/page.tsx')).not.toContain('GoogleAdsTag');
    const login = src('../app/login/page.tsx');
    expect(login).not.toContain('<GoogleAdsTag');
    const reg = login.indexOf('await authApi.register(');
    const conv = login.indexOf('reportGoogleAdsSignup();');
    expect(reg).toBeGreaterThan(-1);
    expect(conv).toBeGreaterThan(reg);
    expect(login.indexOf('router.push(redirectTo);', conv)).toBeGreaterThan(conv);
  });

  it('the Ad Manager library (in-app ad slot) never loads for a child session either', () => {
    const landing = src('../app/crossmodel/page.tsx');
    expect(landing).toContain('setAdLibAllowed(googleAdsAllowedForToken(token));');
    expect(landing).toMatch(/\{adLibAllowed && !isKid && \(\s*<Script\s+id="gpt-js"/);
  });
});

/** Every .ts/.tsx source under the frontend's app/, components/ and lib/ (tests and node_modules excluded). */
function frontendSources(): Array<{ rel: string; text: string }> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push({ rel: p.slice(root.length), text: readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['app', 'components', 'lib']) walk(join(root, d));
  return out;
}

describe('Google Analytics GA4 on the ONE Google tag (ticket 4bb5fe23)', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED;
    delete process.env.NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED;
  });

  it('gtag.js loads by the GA4 id (Google\'s GA snippet) and configures GA4 then the Ads account — one config per destination', () => {
    expect(GOOGLE_ANALYTICS_ID).toBe('G-NK7XPHC7FE');
    expect(googleTagLoaderId()).toBe('G-NK7XPHC7FE');
    expect(googleTagConfigIds()).toEqual(['G-NK7XPHC7FE', 'AW-16512038948']);
    const b = googleAdsBootstrap();
    expect(b).toBe([
      'window.dataLayer = window.dataLayer || [];',
      'function gtag(){dataLayer.push(arguments);}',
      "gtag('js', new Date());",
      "gtag('config', 'G-NK7XPHC7FE');",
      "gtag('config', 'AW-16512038948');",
    ].join('\n'));
  });

  it('NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=1 restores the Ads-only bootstrap byte-for-byte', () => {
    const adsOnly = googleAdsBootstrap(GOOGLE_ADS_CONFIG_IDS);
    process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED = '1';
    expect(googleTagConfigIds()).toEqual(GOOGLE_ADS_CONFIG_IDS);
    expect(googleTagLoaderId()).toBe('AW-16512038948');
    expect(googleAdsBootstrap()).toBe(adsOnly);
    expect(googleAdsBootstrap()).not.toContain('G-NK7XPHC7FE');
  });

  it('a child session switches GA4 off too (ga-disable-G-NK7XPHC7FE), whatever the GA switch says', () => {
    const win: Record<string, unknown> = {};
    disableGoogleAds(win);
    expect(win['ga-disable-G-NK7XPHC7FE']).toBe(true);
    process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED = '1';
    const win2: Record<string, unknown> = {};
    disableGoogleAds(win2);
    expect(win2['ga-disable-G-NK7XPHC7FE']).toBe(true);
  });

  it('ONE gtag.js in the whole frontend: only GoogleAdsTag loads it, GA rides its bootstrap; the Ads master switch still blocks the tag', () => {
    const loaders = frontendSources().filter((f) => f.text.includes('googletagmanager.com/gtag/js'));
    expect(loaders.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['app/GoogleAdsTag.tsx']);
    const tag = src('../app/GoogleAdsTag.tsx');
    expect(tag.match(/googletagmanager\.com\/gtag\/js/g)).toHaveLength(1);
    expect(tag.match(/<Script /g)).toHaveLength(2); // the one loader + its inline bootstrap
    expect(tag).toContain('{googleAdsBootstrap()}');
    expect(tag).toContain('if (googleAdsTagDisabled() || !allowed) return null;');
    // The build-time switch reaches the bundle (Dockerfile ARG → ENV, like the Ads switch).
    const docker = src('../Dockerfile');
    expect(docker).toContain('ARG NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=');
    expect(docker).toContain('ENV NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED=$NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED');
  });

  it('the privacy policy no longer claims "no third-party analytics"', () => {
    const privacy = src('../app/(site)/privacy/page.tsx');
    expect(privacy).not.toContain('We do not use tracking cookies or third-party analytics.');
    expect(privacy).toContain('Google Analytics');
    expect(privacy).toContain('never load for Digby Kids accounts');
  });
});
