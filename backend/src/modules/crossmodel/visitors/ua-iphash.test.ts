/**
 * Coarse UA families + obvious-bot detection, and the visitor IP HASH (never a raw IP) — owner 2026-10-07.
 */
import crypto from 'crypto';
import { parseUserAgent, uaFamilyString } from './ua';
import { hashIp, normalizeIpForHash, visitorHashKey, VISITOR_HASH_LABEL, IP_HASH_HEX_LEN } from './ip-hash';

describe('parseUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'chrome/macos/desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0', 'edge/windows/desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'safari/ios/mobile'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'safari/ios/tablet'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', 'chrome/android/mobile'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'chrome/android/tablet'],
    ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox/linux/desktop'],
    ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'samsung/android/mobile'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'chrome/chromeos/desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS]', 'safari/ios/mobile'],
  ])('%s → %s', (ua, family) => {
    const info = parseUserAgent(ua);
    expect(info.bot).toBe(false);
    expect(uaFamilyString(info)).toBe(family);
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0 Safari/537.36',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Go-http-client/1.1',
    'node-fetch/1.0',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'GPTBot/1.0',
    'Chrome-Lighthouse',
    '',
  ])('obvious bot: %s', (ua) => {
    expect(parseUserAgent(ua).bot).toBe(true);
  });

  it('a phone brand containing "bot" is not a bot', () => {
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36').bot).toBe(false);
  });

  it('never throws on junk', () => {
    expect(parseUserAgent(undefined).bot).toBe(true);
    expect(parseUserAgent(42 as any).bot).toBe(true);
    expect(parseUserAgent('x'.repeat(10_000)).browser).toBe('other');
  });
});

describe('hashIp — HMAC, never the raw address', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  it('is an HMAC-SHA256 under VISITOR_HASH_SECRET, truncated to 32 hex chars', () => {
    process.env.VISITOR_HASH_SECRET = 'sekret';
    const expected = crypto.createHmac('sha256', Buffer.from('sekret')).update('203.0.113.9').digest('hex').slice(0, 32);
    expect(hashIp('203.0.113.9')).toBe(expected);
    expect(hashIp('203.0.113.9')).toHaveLength(IP_HASH_HEX_LEN);
    expect(hashIp('203.0.113.9')).not.toContain('203');
  });

  it('without VISITOR_HASH_SECRET the key derives from JWT_SECRET with the fixed label', () => {
    delete process.env.VISITOR_HASH_SECRET;
    process.env.JWT_SECRET = 'j'.repeat(40);
    const key = crypto.createHmac('sha256', 'j'.repeat(40)).update(VISITOR_HASH_LABEL).digest();
    expect(visitorHashKey().equals(key)).toBe(true);
    expect(hashIp('198.51.100.1')).toBe(crypto.createHmac('sha256', key).update('198.51.100.1').digest('hex').slice(0, 32));
  });

  it('is stable for one address and differs across addresses and secrets', () => {
    process.env.VISITOR_HASH_SECRET = 'a';
    const a1 = hashIp('192.0.2.1');
    expect(hashIp('192.0.2.1')).toBe(a1);
    expect(hashIp('192.0.2.2')).not.toBe(a1);
    process.env.VISITOR_HASH_SECRET = 'b';
    expect(hashIp('192.0.2.1')).not.toBe(a1);
  });

  it('normalizes IPv4-mapped IPv6, ports and brackets; missing / unknown → null', () => {
    process.env.VISITOR_HASH_SECRET = 'n';
    expect(normalizeIpForHash('::ffff:192.0.2.5')).toBe('192.0.2.5');
    expect(normalizeIpForHash('192.0.2.5:443')).toBe('192.0.2.5');
    expect(normalizeIpForHash('[2001:db8::1]')).toBe('2001:db8::1');
    expect(hashIp('::ffff:192.0.2.5')).toBe(hashIp('192.0.2.5'));
    expect(hashIp('')).toBeNull();
    expect(hashIp('unknown')).toBeNull();
    expect(hashIp(undefined)).toBeNull();
  });
});
