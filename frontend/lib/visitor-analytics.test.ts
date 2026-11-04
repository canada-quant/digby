/**
 * First-party visitor analytics — the web capture (owner 2026-10-07): the channel table (the SAME cases the backend
 * pins in visitors/attribution.test.ts), the landing reader, first touch never overwritten, last touch only on a
 * sourced landing, batching / beacon, the Digby Kids exclusion (the Google tag's fail-closed token read), the build
 * kill switch, and where it is wired.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  classifyChannel, createVisitorCapture, readTouch, normalizePath, hasSource, referrerHost, CaptureEnv,
  VISITOR_KEY, FIRST_TOUCH_KEY, LAST_TOUCH_KEY, VISIT_EVENTS_ENDPOINT, VISITOR_COOKIE_MAX_AGE_S, MAX_BATCH,
} from './visitor-analytics';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;

describe('classifyChannel — the same table as the server', () => {
  const cases: Array<[Record<string, unknown> | null, string]> = [
    [{ gclid: 'g' }, 'google_ads'], [{ gbraid: 'g' }, 'google_ads'], [{ wbraid: 'g' }, 'google_ads'],
    [{ gclid: 'g', utm_source: 'facebook', utm_medium: 'cpc' }, 'google_ads'],
    [{ fbclid: 'f' }, 'facebook_ads'], [{ msclkid: 'm' }, 'bing_ads'], [{ ttclid: 't' }, 'tiktok_ads'], [{ li_fat_id: 'l' }, 'linkedin_ads'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'google_ads'], [{ utm_source: 'Google', utm_medium: 'PPC' }, 'google_ads'],
    [{ utm_source: 'facebook', utm_medium: 'paid_social' }, 'facebook_ads'], [{ utm_source: 'instagram', utm_medium: 'cpc' }, 'facebook_ads'],
    [{ utm_source: 'meta', utm_medium: 'paidsocial' }, 'facebook_ads'], [{ utm_source: 'bing', utm_medium: 'cpc' }, 'bing_ads'],
    [{ utm_source: 'reddit', utm_medium: 'cpc' }, 'other_paid'],
    [{ utm_source: 'newsletter', utm_medium: 'email' }, 'email'], [{ utm_source: 'facebook', utm_medium: 'social' }, 'social_organic'],
    [{ utm_source: 'google', utm_medium: 'organic' }, 'organic_search'], [{ utm_source: 'partner', utm_medium: 'referral' }, 'referral'],
    [{ utm_source: 'twitter' }, 'social_organic'], [{ utm_source: 'podcast', utm_medium: 'audio' }, 'other_campaign'],
    [{ referrer: 'google.com' }, 'organic_search'], [{ referrer: 'google.co.uk' }, 'organic_search'], [{ referrer: 'duckduckgo.com' }, 'organic_search'],
    [{ referrer: 'facebook.com' }, 'social_organic'], [{ referrer: 't.co' }, 'social_organic'], [{ referrer: 'mail.google.com' }, 'email'],
    [{ referrer: 'news.example.org' }, 'referral'], [{ referrer: 'digby.example.com' }, 'direct'], [{}, 'direct'], [null, 'direct'],
  ];
  it.each(cases)('%j → %s', (touch, expected) => {
    expect(classifyChannel(touch as any)).toBe(expected);
  });
});

describe('readTouch / normalizePath / referrerHost', () => {
  it('reads utm + click ids + the external referrer host + the normalized landing path', () => {
    const t = readTouch('https://digby.example.com/crossmodel?utm_source=google&utm_medium=cpc&utm_campaign=fall&gclid=Cj0&email=x@y.z', 'https://www.google.com/search?q=private', 5);
    expect(t).toEqual({ ts: 5, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall', gclid: 'Cj0', landing: '/crossmodel', referrer: 'google.com' });
    expect(JSON.stringify(t)).not.toContain('private');
    expect(JSON.stringify(t)).not.toContain('x@y.z');
  });
  it('drops an internal referrer; a direct landing has no source', () => {
    const t = readTouch('https://digby.example.com/', 'https://digby.example.com/login', 1);
    expect(t.referrer).toBeUndefined();
    expect(hasSource(t)).toBe(false);
  });
  it('collapses ids in paths', () => {
    expect(normalizePath('/crossmodel/projects/123e4567-e89b-12d3-a456-426614174000?x=1')).toBe('/crossmodel/projects/:id');
    expect(normalizePath('/crossmodel/shared/abcDEF1234567890xyzQRS')).toBe('/crossmodel/shared/:token');
    expect(referrerHost('not a url')).toBeUndefined();
  });
});

/** A fake browser: a cookie jar, localStorage, a fetch / beacon recorder and a manual timer. */
function fakeEnv(opts: Partial<Omit<CaptureEnv, 'href' | 'referrer' | 'token'>> & { href?: string; referrer?: string; token?: string | null } = {}) {
  const { href: hrefStr, referrer: refStr, token: tokenStr, ...over } = opts;
  const cookies = new Map<string, { value: string; maxAge: number }>();
  const store = new Map<string, string>();
  const fetches: Array<{ url: string; init: any }> = [];
  const beacons: Array<{ url: string; data: any }> = [];
  let timerFn: (() => void) | null = null;
  let uuidN = 0;
  let token = tokenStr ?? null;
  const env: CaptureEnv = {
    href: () => hrefStr ?? 'https://digby.example.com/',
    referrer: () => refStr ?? '',
    getCookie: (n) => cookies.get(n)?.value ?? null,
    setCookie: (n, v, maxAge) => { cookies.set(n, { value: v, maxAge }); },
    deleteCookie: (n) => { cookies.delete(n); },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } },
    token: () => token,
    sendBeacon: over.sendBeacon ?? ((url, data) => { beacons.push({ url, data }); return true; }),
    fetch: async (url, init) => { fetches.push({ url, init }); return {}; },
    now: () => 1_700_000_000_000,
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++uuidN).padStart(12, '0')}`,
    setTimer: (fn) => { timerFn = fn; return 1; },
    clearTimer: () => { timerFn = null; },
    ...over,
  };
  return { env, cookies, store, fetches, beacons, runTimer: () => { const f = timerFn; timerFn = null; f?.(); }, setToken: (t: string | null) => { token = t; } };
}

const bodyOf = (f: { init: any }) => JSON.parse(f.init.body);

describe('createVisitorCapture', () => {
  afterEach(() => { delete process.env.NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED; });

  it('mints ONE random visitor id in a 13-month first-party cookie + localStorage, and records the first touch', () => {
    const f = fakeEnv({ href: 'https://digby.example.com/?fbclid=IwAR&utm_campaign=spring', referrer: 'https://l.facebook.com/' });
    const cap = createVisitorCapture(f.env);
    cap.land();
    const id = f.cookies.get(VISITOR_KEY)!;
    expect(id.value).toMatch(/^aaaaaaaa-aaaa-4aaa-8aaa-/);
    expect(id.maxAge).toBe(VISITOR_COOKIE_MAX_AGE_S);
    expect(VISITOR_COOKIE_MAX_AGE_S).toBe(395 * 24 * 3600);
    expect(f.store.get(VISITOR_KEY)).toBe(id.value);
    const ft = JSON.parse(decodeURIComponent(f.cookies.get(FIRST_TOUCH_KEY)!.value));
    expect(ft).toMatchObject({ fbclid: 'IwAR', utm_campaign: 'spring', referrer: 'l.facebook.com', landing: '/' });
    expect(classifyChannel(ft)).toBe('facebook_ads');
  });

  it('the FIRST touch is never overwritten; the LAST touch moves only on a landing that carries a source', () => {
    const f1 = fakeEnv({ href: 'https://digby.example.com/?gclid=G1' });
    createVisitorCapture(f1.env).land();
    // a later page load (new capture instance, same storage) from a facebook ad
    const f2 = fakeEnv({ href: 'https://digby.example.com/?fbclid=F2' });
    for (const [k, v] of f1.cookies) f2.cookies.set(k, v);
    for (const [k, v] of f1.store) f2.store.set(k, v);
    createVisitorCapture(f2.env).land();
    expect(JSON.parse(decodeURIComponent(f2.cookies.get(FIRST_TOUCH_KEY)!.value)).gclid).toBe('G1');
    expect(JSON.parse(decodeURIComponent(f2.cookies.get(LAST_TOUCH_KEY)!.value)).fbclid).toBe('F2');
    expect(f2.cookies.get(VISITOR_KEY)!.value).toBe(f1.cookies.get(VISITOR_KEY)!.value);
    // a direct revisit moves neither
    const f3 = fakeEnv({ href: 'https://digby.example.com/crossmodel' });
    for (const [k, v] of f2.cookies) f3.cookies.set(k, v);
    createVisitorCapture(f3.env).land();
    expect(JSON.parse(decodeURIComponent(f3.cookies.get(LAST_TOUCH_KEY)!.value)).fbclid).toBe('F2');
  });

  it('the id survives a cleared cookie via localStorage (and heals the cookie)', () => {
    const f = fakeEnv();
    f.store.set(VISITOR_KEY, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    createVisitorCapture(f.env).land();
    expect(f.cookies.get(VISITOR_KEY)!.value).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('queues page views and flushes ONE batch (fetch keepalive JSON, Bearer when signed in) after the delay', () => {
    const token = jwt({ userId: 'u', isChild: false });
    const f = fakeEnv({ href: 'https://digby.example.com/?utm_source=google&utm_medium=cpc', token });
    const cap = createVisitorCapture(f.env);
    cap.land();
    cap.track('page_view', undefined, '/crossmodel?secret=1');
    cap.track('signup_view', undefined, '/login');
    expect(f.fetches).toHaveLength(0);
    f.runTimer();
    expect(f.fetches).toHaveLength(1);
    const req = f.fetches[0];
    expect(req.url).toBe(VISIT_EVENTS_ENDPOINT);
    expect(req.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
    expect(req.init.headers.Authorization).toBe(`Bearer ${token}`);
    const body = bodyOf(req);
    expect(body.visitorId).toBe(f.cookies.get(VISITOR_KEY)!.value);
    expect(body.events.map((e: any) => [e.type, e.path])).toEqual([['page_view', '/crossmodel'], ['signup_view', '/login']]);
    expect(body.attribution.first).toMatchObject({ utm_source: 'google', utm_medium: 'cpc' });
  });

  it('flush({beacon}) uses sendBeacon with a text/plain body; a refused beacon falls back to fetch', () => {
    const f = fakeEnv();
    const cap = createVisitorCapture(f.env);
    cap.track('page_view', undefined, '/');
    cap.flush({ beacon: true });
    expect(f.beacons).toHaveLength(1);
    expect(f.beacons[0].url).toBe(VISIT_EVENTS_ENDPOINT);
    expect(f.fetches).toHaveLength(0);
    const g = fakeEnv({ sendBeacon: () => false });
    const cap2 = createVisitorCapture(g.env);
    cap2.track('page_view', undefined, '/');
    cap2.flush({ beacon: true });
    expect(g.fetches).toHaveLength(1);
  });

  it('{flush:true} sends at once (signup_complete before the redirect); > 50 events split into batches', () => {
    const f = fakeEnv();
    const cap = createVisitorCapture(f.env);
    cap.track('signup_complete', undefined, '/login', { flush: true });
    expect(f.fetches).toHaveLength(1);
    for (let i = 0; i < 19; i++) cap.track('page_view', undefined, `/p${i}`);
    for (let i = 0; i < MAX_BATCH + 10; i++) cap.queue.push({ type: 'page_view', path: '/', ts: 1 });
    cap.flush();
    expect(f.fetches.slice(1).map((r) => bodyOf(r).events.length)).toEqual([MAX_BATCH, 29]);
  });

  it('Digby Kids: a child token sends NOTHING and erases the visitor id + touches; an unreadable token fails closed', () => {
    const f = fakeEnv({ href: 'https://digby.example.com/?gclid=G' });
    const cap = createVisitorCapture(f.env);
    cap.land();
    cap.track('page_view', undefined, '/');
    expect(f.cookies.has(VISITOR_KEY)).toBe(true);
    f.setToken(jwt({ userId: 'kid', isChild: true }));
    cap.track('page_view', undefined, '/crossmodel');
    cap.flush();
    f.runTimer();
    expect(f.fetches).toHaveLength(0);
    expect(f.cookies.size).toBe(0);
    expect(f.store.size).toBe(0);
    expect(cap.visitorId()).toBeNull();
    const g = fakeEnv({ token: 'garbage' });
    const cap2 = createVisitorCapture(g.env);
    cap2.land();
    cap2.track('page_view', undefined, '/', { flush: true });
    expect(g.fetches).toHaveLength(0);
    expect(g.cookies.size).toBe(0);
  });

  it('NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=1: no id, no request', () => {
    process.env.NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED = '1';
    const f = fakeEnv({ href: 'https://digby.example.com/?gclid=G' });
    const cap = createVisitorCapture(f.env);
    cap.land();
    cap.track('page_view', undefined, '/', { flush: true });
    expect(f.fetches).toHaveLength(0);
    expect(f.cookies.size).toBe(0);
    expect(cap.visitorId()).toBeNull();
  });

  it('visitorId() never mints an id (the API header only carries an existing one)', () => {
    const f = fakeEnv();
    const cap = createVisitorCapture(f.env);
    expect(cap.visitorId()).toBeNull();
    cap.land();
    expect(cap.visitorId()).toBe(f.cookies.get(VISITOR_KEY)!.value);
  });

  it('never throws when storage / cookies / fetch blow up', () => {
    const boom = () => { throw new Error('blocked'); };
    const f = fakeEnv({ getCookie: boom as any, setCookie: boom as any, deleteCookie: boom as any, storage: null, fetch: boom as any });
    const cap = createVisitorCapture(f.env);
    expect(() => { cap.land(); cap.track('page_view', undefined, '/', { flush: true }); cap.forget(); }).not.toThrow();
  });
});

describe('wiring', () => {
  it('app/layout.tsx renders the capture once on every page, beside the Google tag', () => {
    const layout = src('../app/layout.tsx');
    expect(layout).toContain("import { VisitorAnalytics } from './VisitorAnalytics';");
    expect(layout.split('<VisitorAnalytics />').length - 1).toBe(1);
    const comp = src('../app/VisitorAnalytics.tsx');
    expect(comp).toContain("cap.track('page_view', undefined, pathname || '/')");
    expect(comp).toContain('flush({ beacon: true })');
  });

  it('the login page records signup_view / login_view / signup_complete / login; the home composer chat_sent', () => {
    const login = src('../app/login/page.tsx');
    expect(login).toContain("trackVisitEvent(tab === 'signup' ? 'signup_view' : 'login_view')");
    expect(login).toContain("trackVisitEvent('signup_complete', undefined, { flush: true })");
    expect(login).toContain("trackVisitEvent('login', undefined, { flush: true })");
    expect(src('../app/crossmodel/page.tsx')).toContain("trackVisitEvent('chat_sent', { surface: user ? 'home' : 'guest' })");
    // the sign-up prompts (header + the guest rail) are a funnel step too
    expect(src('../app/crossmodel/page.tsx')).toContain("trackVisitEvent('signup_cta', { where: 'header' }, { flush: true })");
    expect(src('../app/crossmodel/components/GuestSidebar.tsx')).toContain("trackVisitEvent('signup_cta', { where: 'guest_sidebar' }, { flush: true })");
  });

  it('the API client carries the visitor id header (stitching) — null for kids / the switch', () => {
    const client = src('./api-client.ts');
    expect(client).toContain('const visitorId = visitorIdForHeader();');
    expect(client).toContain('if (visitorId) config.headers[VISITOR_HEADER] = visitorId;');
  });

  it('privacy §7 discloses the first-party analytics and keeps the Google-tags sentence; the build arg is plumbed', () => {
    const privacy = src('../app/(site)/privacy/page.tsx');
    expect(privacy).toContain('Google Analytics');
    expect(privacy).toContain('a random visitor id (a first-party cookie, kept 13 months), a one-way hash of your IP address (never the address itself) and the traffic source');
    expect(privacy).toContain('Digby Kids accounts are never tracked');
    expect(src('../Dockerfile')).toContain('ARG NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=');
  });
});
