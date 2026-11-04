import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Clean public URLs for the Digby app (owner 2026-10-14: "remove the exposed
 * routes of digby.example.com/crossmodel … crossmodel was the old name").
 *
 * The chat app still LIVES under app/crossmodel/* on disk; users and crawlers
 * only ever see the clean paths:
 *
 *   /                → /crossmodel            (rewrite — the chat home)
 *   /account …       → /crossmodel/account …  (rewrite, see APP_SUB_PATHS)
 *
 * and a GET of a legacy /crossmodel… URL (old bookmarks, emails, OAuth
 * callbacks, stored agent links, search-engine results) is 308'd to its clean
 * twin with the query string intact. Client-side navigations get the same 308
 * (Next strips the RSC markers before the proxy runs, verified against
 * `next start` 2026-10-14) and the app router follows it; the rewrites above
 * never re-enter the proxy, so the internal /crossmodel target is unaffected.
 *
 * Marketing / SEO pages (/about, /features, /private-ai …) and the legal pages
 * (/privacy, /terms) are real top-level routes under app/(site) and pass
 * straight through.
 */

/** App screens served from app/crossmodel/<segment>. */
export const APP_SUB_PATHS = [
  'account',
  'admin',
  'files',
  'instances',
  'management',
  'profile',
  'projects',
  'shared',
] as const;

/** Legacy pages that moved OUT of app/crossmodel (next.config.ts also redirects these for client navigations). */
const MOVED_PAGES: Record<string, string> = {
  '/crossmodel/privacy': '/privacy',
  '/crossmodel/terms': '/terms',
};

const SKIP_PREFIXES = ['/dashboard', '/login', '/api', '/_next', '/help'];

function matchesSegment(pathname: string, segment: string): boolean {
  return pathname === `/${segment}` || pathname.startsWith(`/${segment}/`);
}

/** The clean public path for a legacy /crossmodel… pathname, or null when it has none. */
export function cleanPathFor(pathname: string): string | null {
  if (MOVED_PAGES[pathname]) return MOVED_PAGES[pathname];
  if (pathname === '/crossmodel' || pathname === '/crossmodel/') return '/';
  if (!pathname.startsWith('/crossmodel/')) return null;
  const rest = pathname.slice('/crossmodel'.length); // "/account/…"
  return APP_SUB_PATHS.some((seg) => matchesSegment(rest, seg)) ? rest : null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/crossmodel' || pathname.startsWith('/crossmodel/')) {
    const clean = cleanPathFor(pathname);
    const method = request.method.toUpperCase();
    if (clean && (method === 'GET' || method === 'HEAD')) {
      const url = request.nextUrl.clone();
      url.pathname = clean;
      return NextResponse.redirect(url, 308);
    }
    return NextResponse.next();
  }

  if (SKIP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // Root → the chat home.
  if (pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/crossmodel';
    return NextResponse.rewrite(url);
  }

  // App screens → their internal routes.
  if (APP_SUB_PATHS.some((seg) => matchesSegment(pathname, seg))) {
    const url = request.nextUrl.clone();
    url.pathname = `/crossmodel${pathname}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files, images, and Next.js internals
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.ico|.*\\.svg|.*\\.gif|.*\\.xml|.*\\.txt|.*\\.webmanifest).*)',
  ],
};
