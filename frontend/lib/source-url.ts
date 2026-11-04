/**
 * source-url — display helpers for the RAG/web Sources pills.
 *
 * Feedback a2063c30: the Sources row rendered unresolved Google redirect
 * wrappers, so every pill read "www.google.com". The backend has unwrapped
 * redirect URLs at collection time since PR #208 (widened by #229/#242), but
 * messages stored BEFORE that fix still carry the wrappers — these helpers
 * resolve them at display time and give every pill its real destination link.
 */

// google.com / google.ca / google.co.uk … redirect endpoints (/url, /link).
const REDIRECT_HOST_RE = /(^|\.)google\.[a-z.]+$/i;

/** Unwrap a known search-engine redirect wrapper to its destination URL. */
export function resolveSourceUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (REDIRECT_HOST_RE.test(u.hostname) && (u.pathname === '/url' || u.pathname === '/link')) {
      const dest = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('u');
      if (dest && /^https?:\/\//i.test(dest)) return dest;
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Short display label for a source URL: resolved hostname, sans leading www. */
export function sourceDisplayHost(raw: string): string {
  const resolved = resolveSourceUrl(raw);
  try {
    return new URL(resolved).hostname.replace(/^www\./, '');
  } catch {
    return resolved;
  }
}
