import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site/content';

/**
 * /robots.txt — crawl the public site + the chat home; keep crawlers out of
 * signed-in app screens and the API. The legacy /crossmodel paths stay
 * crawlable so search engines see their 308s to the clean URLs, and shared
 * conversations stay crawlable so engines see their noindex (a robots.txt
 * block would hide it).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/account',
          '/admin',
          '/files',
          '/instances',
          '/management',
          '/profile',
          '/projects',
          '/dashboard',
          '/help',
          '/dev-accordion-harness',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
