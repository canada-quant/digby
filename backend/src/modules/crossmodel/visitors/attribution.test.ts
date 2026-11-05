/**
 * Traffic-source attribution (owner 2026-10-07) — the deterministic channel table, the touch sanitizer and the
 * analytics path normalizer.
 */
import { CHANNELS, classifyChannel, hasSource, isOwnHost, normalizePath, referrerHost, sanitizeTouch, campaignOf, PAID_CHANNELS, CHANNEL_LABELS } from './attribution';

describe('classifyChannel — the channel table', () => {
  const cases: Array<[string, Record<string, unknown> | null, string]> = [
    // click ids win over everything
    ['gclid', { gclid: 'Cj0KCQ' }, 'google_ads'],
    ['gbraid (iOS app-to-web)', { gbraid: 'x' }, 'google_ads'],
    ['wbraid (iOS web-to-app)', { wbraid: 'x' }, 'google_ads'],
    ['gclid beats a facebook utm', { gclid: 'g', utm_source: 'facebook', utm_medium: 'cpc' }, 'google_ads'],
    ['fbclid', { fbclid: 'IwAR' }, 'facebook_ads'],
    ['fbclid with an organic referrer', { fbclid: 'IwAR', referrer: 'l.facebook.com' }, 'facebook_ads'],
    ['msclkid → bing', { msclkid: 'm' }, 'bing_ads'],
    ['ttclid → tiktok', { ttclid: 't' }, 'tiktok_ads'],
    ['li_fat_id → linkedin', { li_fat_id: 'l' }, 'linkedin_ads'],
    // paid utm
    ['utm google / cpc', { utm_source: 'google', utm_medium: 'cpc' }, 'google_ads'],
    ['utm Google / PPC (case)', { utm_source: 'Google', utm_medium: 'PPC' }, 'google_ads'],
    ['utm adwords / paid', { utm_source: 'adwords', utm_medium: 'paid' }, 'google_ads'],
    ['utm youtube / display', { utm_source: 'youtube', utm_medium: 'display' }, 'google_ads'],
    ['utm facebook / paid_social', { utm_source: 'facebook', utm_medium: 'paid_social' }, 'facebook_ads'],
    ['utm instagram / cpc', { utm_source: 'instagram', utm_medium: 'cpc' }, 'facebook_ads'],
    ['utm meta / paidsocial', { utm_source: 'meta', utm_medium: 'paidsocial' }, 'facebook_ads'],
    ['utm fb / cpm', { utm_source: 'fb', utm_medium: 'cpm' }, 'facebook_ads'],
    ['utm bing / cpc', { utm_source: 'bing', utm_medium: 'cpc' }, 'bing_ads'],
    ['utm tiktok / paid', { utm_source: 'tiktok', utm_medium: 'paid' }, 'tiktok_ads'],
    ['utm linkedin / sponsored', { utm_source: 'linkedin', utm_medium: 'sponsored' }, 'linkedin_ads'],
    ['utm reddit / cpc → other paid', { utm_source: 'reddit', utm_medium: 'cpc' }, 'other_paid'],
    // non-paid utm
    ['utm newsletter / email', { utm_source: 'newsletter', utm_medium: 'email' }, 'email'],
    ['utm medium e-mail', { utm_source: 'x', utm_medium: 'e-mail' }, 'email'],
    ['utm facebook / social (organic)', { utm_source: 'facebook', utm_medium: 'social' }, 'social_organic'],
    ['utm google / organic', { utm_source: 'google', utm_medium: 'organic' }, 'organic_search'],
    ['utm partner / referral', { utm_source: 'partner', utm_medium: 'referral' }, 'referral'],
    ['utm twitter with no medium', { utm_source: 'twitter' }, 'social_organic'],
    ['utm bing with no medium', { utm_source: 'bing' }, 'organic_search'],
    ['utm unknown source + medium', { utm_source: 'podcast', utm_medium: 'audio' }, 'other_campaign'],
    ['utm campaign only', { utm_campaign: 'launch' }, 'other_campaign'],
    // referrer-only
    ['google.com referrer', { referrer: 'google.com' }, 'organic_search'],
    ['google.co.uk referrer', { referrer: 'google.co.uk' }, 'organic_search'],
    ['bing referrer', { referrer: 'bing.com' }, 'organic_search'],
    ['duckduckgo referrer', { referrer: 'duckduckgo.com' }, 'organic_search'],
    ['yahoo search referrer', { referrer: 'search.yahoo.com' }, 'organic_search'],
    ['facebook referrer without fbclid', { referrer: 'facebook.com' }, 'social_organic'],
    ['l.facebook.com referrer', { referrer: 'l.facebook.com' }, 'social_organic'],
    ['t.co referrer', { referrer: 't.co' }, 'social_organic'],
    ['reddit referrer', { referrer: 'old.reddit.com' }, 'social_organic'],
    ['gmail webmail referrer', { referrer: 'mail.google.com' }, 'email'],
    ['other site referrer', { referrer: 'news.example.org' }, 'referral'],
    ['own host referrer is internal → direct', { referrer: 'digby.ai' }, 'direct'],
    ['own subdomain referrer → direct', { referrer: 'app.digby.ai' }, 'direct'],
    // nothing
    ['empty touch', {}, 'direct'],
    ['null touch', null, 'direct'],
    ['landing only', { landing: '/' }, 'direct'],
  ];
  it.each(cases)('%s', (_name, touch, expected) => {
    expect(classifyChannel(touch as any)).toBe(expected);
    expect(CHANNELS).toContain(expected);
  });

  it('every channel has a label; the paid set is exactly the ad networks + other paid', () => {
    for (const c of CHANNELS) expect(typeof CHANNEL_LABELS[c]).toBe('string');
    expect([...PAID_CHANNELS].sort()).toEqual(['bing_ads', 'facebook_ads', 'google_ads', 'linkedin_ads', 'other_paid', 'tiktok_ads']);
  });
});

describe('sanitizeTouch', () => {
  it('keeps only known keys, trims and caps values, reduces the referrer to its host and the landing to a path', () => {
    const t = sanitizeTouch({
      utm_source: '  google ', utm_campaign: 'x'.repeat(500), gclid: 'abc', evil: 'drop me',
      referrer: 'https://www.Google.com/search?q=secret', landing: '/pricing?email=a@b.c#frag', ts: 5,
    }, 10_000);
    expect(t).toEqual({ utm_source: 'google', utm_campaign: 'x'.repeat(200), gclid: 'abc', referrer: 'google.com', landing: '/pricing', ts: 5 });
    expect(JSON.stringify(t)).not.toContain('secret');
    expect(JSON.stringify(t)).not.toContain('a@b.c');
  });

  it('clamps a timestamp into [now − 400 d, now] and drops junk', () => {
    const now = Date.UTC(2026, 9, 7);
    expect(sanitizeTouch({ ts: now + 99_999 }, now)?.ts).toBe(now);
    expect(sanitizeTouch({ ts: 1 }, now)?.ts).toBe(now - 400 * 86_400_000);
    expect(sanitizeTouch(null)).toBeNull();
    expect(sanitizeTouch('x')).toBeNull();
    expect(sanitizeTouch([1, 2])).toBeNull();
    expect(sanitizeTouch({ nope: 1 })).toBeNull();
  });
});

describe('referrerHost / isOwnHost / hasSource', () => {
  it('parses URLs and bare hosts, lower-cases, strips www. and ports', () => {
    expect(referrerHost('https://WWW.Example.com:8443/a?b=c')).toBe('example.com');
    expect(referrerHost('example.com/path')).toBe('example.com');
    expect(referrerHost('android-app://com.google.android.gm/')).toBe('com.google.android.gm');
    expect(referrerHost('not a host')).toBeUndefined();
    expect(referrerHost('')).toBeUndefined();
    expect(referrerHost(42)).toBeUndefined();
  });
  it('knows Digby\'s own hosts', () => {
    expect(isOwnHost('digby.ai')).toBe(true);
    expect(isOwnHost('staging.digby.ai')).toBe(true);
    expect(isOwnHost('localhost')).toBe(true);
    expect(isOwnHost('notdigby.ai')).toBe(false);
  });
  it('a source = a utm tag, a click id or an EXTERNAL referrer', () => {
    expect(hasSource({ utm_source: 'x' })).toBe(true);
    expect(hasSource({ fbclid: 'x' })).toBe(true);
    expect(hasSource({ referrer: 'google.com' })).toBe(true);
    expect(hasSource({ referrer: 'digby.ai' })).toBe(false);
    expect(hasSource({ landing: '/' })).toBe(false);
    expect(hasSource(null)).toBe(false);
  });
  it('campaignOf is the utm_campaign or null', () => {
    expect(campaignOf({ utm_campaign: 'fall' })).toBe('fall');
    expect(campaignOf({ gclid: 'g' })).toBeNull();
    expect(campaignOf(null)).toBeNull();
  });
});

describe('normalizePath', () => {
  it.each([
    ['/crossmodel?chat=123&token=secret', '/crossmodel'],
    ['/crossmodel/projects/123e4567-e89b-12d3-a456-426614174000', '/crossmodel/projects/:id'],
    ['/crossmodel/shared/abcDEF1234567890xyzQRS', '/crossmodel/shared/:token'],
    ['/coding/sessions/12345/diff', '/coding/sessions/:n/diff'],
    ['https://digby.ai/help/depth#x', '/help/depth'],
    ['', '/'],
    ['/', '/'],
    ['/a/b/c/d/e/f/g/h/i/j/k/l/m/n', '/a/b/c/d/e/f/g/h/i/j/k/l'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
  it('never returns more than 200 chars and strips odd characters', () => {
    expect(normalizePath('/' + 'a'.repeat(300)).length).toBeLessThanOrEqual(200);
    expect(normalizePath('/he<script>llo')).toBe('/hescriptllo');
  });
});
