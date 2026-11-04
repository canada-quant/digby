/**
 * Shared httpOnly access-token cookie helper (findings #8/#9): keeps the JWT
 * out of the SSE URL query and out of localStorage/ad-JS reach. Mirrors the
 * refreshToken cookie. maxAge matches the refresh window so login persists —
 * the short-lived token INSIDE is rotated by /auth/refresh, which resets this
 * cookie, and re-issued (sliding) by the auth middleware on every
 * Bearer-authenticated request so the cookie never drifts from the token the
 * client is actually using (2026-07-23 "Chat not found" SSE fix).
 */

import type { Response } from 'express';

export const ACCESS_COOKIE = 'cm_access';

/**
 * Cookie Secure flag. Defaults to NODE_ENV==='production' but can be forced
 * with COOKIE_SECURE=true|false. A self-hosted instance served over plain-http
 * LAN (no TLS terminator) with NODE_ENV=production would otherwise emit Secure
 * cookies that browsers refuse to store — silently breaking login.
 */
export function cookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function accessCookieOpts() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const, // lax: sent on same-origin XHR + EventSource (SSE)
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

/**
 * Issue (or refresh) the cm_access cookie — at most ONE copy per response.
 *
 * Express's res.cookie() APPENDS a Set-Cookie header on every call, and the
 * auth middlewares used to STACK: each /api/crossmodel router that opened with
 * router.use(authenticate) re-ran it while a request fell through to a later
 * router. Deep-mounted routes paid for that — /coding/* sat behind 8
 * auth-bearing routers, so every authenticated coding response carried 8
 * duplicate ~400-byte cm_access cookies (~3.3KB), pushing total response
 * headers past nginx's default 4KB proxy_buffer_size. nginx then dropped the
 * upstream response and served 502 for every authenticated /coding/* request
 * (2026-07-23 prod outage: "Could not open this coding chat"). The stacking
 * itself is gone (one app-level guard in app.ts authenticates each request
 * exactly once); replacing any previously-issued copy instead of appending
 * stays as defense-in-depth so a response can never accumulate duplicates.
 */
export function issueAccessCookie(res: Response, token: string): void {
  const prev = res.getHeader('Set-Cookie');
  if (prev !== undefined) {
    const all = Array.isArray(prev) ? prev.map(String) : [String(prev)];
    const others = all.filter(c => !c.startsWith(`${ACCESS_COOKIE}=`));
    if (others.length !== all.length) {
      if (others.length) res.setHeader('Set-Cookie', others);
      else res.removeHeader('Set-Cookie');
    }
  }
  res.cookie(ACCESS_COOKIE, token, accessCookieOpts());
}

/**
 * Drop the cm_access cookie (autonomy loop #19): a browser whose refresh token
 * is gone keeps presenting the same EXPIRED access token through this cookie
 * on every poll — the frontend removes its localStorage copy on refresh
 * failure but never this httpOnly cookie, which only the server can clear.
 * Same path/flags as the issue so the browser matches the cookie. Safe on a
 * response object without clearCookie (older test fakes).
 */
export function clearAccessCookie(res: Response): void {
  if (typeof (res as any).clearCookie !== 'function') return;
  const { maxAge: _maxAge, ...opts } = accessCookieOpts();
  (res as any).clearCookie(ACCESS_COOKIE, opts);
}
