/**
 * Coarse user-agent family + obvious-bot detection — pure leaf (visitor analytics, owner 2026-10-07).
 *
 * Only a coarse family is stored ("chrome/macos/desktop") — never the raw user-agent string. An OBVIOUS bot (a
 * crawler / link-preview fetcher / headless browser / HTTP library UA, or no UA at all) is dropped before anything
 * is written; a SUSPECTED one (the page reported navigator.webdriver) is kept with visitors.isBot and excluded
 * from every admin count.
 */

export interface UaInfo {
  browser: 'chrome' | 'safari' | 'firefox' | 'edge' | 'opera' | 'samsung' | 'other';
  os: 'ios' | 'android' | 'windows' | 'macos' | 'chromeos' | 'linux' | 'other';
  device: 'mobile' | 'tablet' | 'desktop';
  bot: boolean;
}

/** Crawlers, link unfurlers, monitors, headless automation and HTTP libraries. */
export const BOT_UA_RE = /(?<!cu)bot(?:[\/\s;)_-]|$)|crawl|spider|slurp|bingpreview|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|quora link preview|whatsapp|telegrambot|discordbot|slackbot|slack-imgproxy|twitterbot|linkedinbot|pinterestbot|redditbot|applebot|yandex|baiduspider|duckduckbot|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|headlesschrome|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|chrome-lighthouse|gtmetrix|pingdom|uptimerobot|statuscake|site24x7|datadog|newrelic|checkly|curl\/|wget\/|python-requests|python-urllib|python\/|aiohttp|httpx|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|libwww|scrapy|httpclient|postmanruntime|insomnia|feedfetcher|google-inspectiontool|googleother|adsbot|mediapartners-google/i;

/** Parse a user agent into its coarse family. Never throws. An empty / missing UA is an obvious bot. */
export function parseUserAgent(raw: unknown): UaInfo {
  const ua = typeof raw === 'string' ? raw.slice(0, 1000) : '';
  if (!ua.trim()) return { browser: 'other', os: 'other', device: 'desktop', bot: true };
  const bot = BOT_UA_RE.test(ua);

  let browser: UaInfo['browser'] = 'other';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'firefox';
  else if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'safari';
  else if (/AppleWebKit\//.test(ua) && /(iPhone|iPad|iPod)/.test(ua)) browser = 'safari'; // in-app iOS web views

  let os: UaInfo['os'] = 'other';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macos';
  else if (/Linux|X11/.test(ua)) os = 'linux';

  let device: UaInfo['device'] = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) device = 'mobile';

  return { browser, os, device, bot };
}

/** The stored family string: "<browser>/<os>/<device>". */
export function uaFamilyString(info: UaInfo): string {
  return `${info.browser}/${info.os}/${info.device}`;
}
