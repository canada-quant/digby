/**
 * Path matchers + client keys for the path-scoped rate limiters in app.ts
 * (stream drops review, 2026-10-20).
 *
 * Every limiter mounts at app.use('/api/crossmodel', …) and SKIPS the requests
 * whose req.path is not its own. Express's default Router is non-strict and
 * case-insensitive: GET /stream/, /STREAM and /SESSION/<id>/Stream reach the
 * same handlers as /stream and /session/<id>/stream (probed on express 5.2.1:
 * only a trailing slash and letter case route — `//stream`, `/stream//`,
 * `/str%65am` and `;x` / `.json` suffixes all 404). An exact-match skip
 * (`req.path !== '/stream'`, or a regex without `\/?` and `i`) therefore let a
 * trailing slash or a case change walk past the limiter — the bypass
 * WEBHOOK_FIRE_PATH_RE (webhook.service.ts) closed for webhooks. Each matcher
 * here accepts exactly what the router matches.
 *
 * The guest reattach limiter keys on the CLIENT — the HMAC of the hops-anchored
 * client ip (clientIpForHash + hashIp, the visit-events rule) — never on
 * express-rate-limit's default `req.ip`: with `trust proxy 1` behind
 * ALB → nginx → Express, req.ip is the ALB node, so every guest on one node
 * shared ONE bucket and a single client could drain it for all of them.
 *
 * Switch (release): RATE_LIMIT_PATH_NORMALIZE_DISABLED=1 — the /stream and
 * /upload limiters skip on the exact path again (pre-2026-10-20). The guest
 * reattach limiter is new with its endpoint (GUEST_STREAM_ATTACH_DISABLED=1
 * removes the endpoint) and always uses the normalized matcher.
 */

import { clientIpForHash } from '../modules/crossmodel/visitors/visitor.service';
import { hashIp } from '../modules/crossmodel/visitors/ip-hash';

/** POST/GET /stream — the paid AI query endpoint. */
export const STREAM_LIMIT_PATH_RE = /^\/stream\/?$/i;
/** POST /upload — the open attachment upload. */
export const UPLOAD_LIMIT_PATH_RE = /^\/upload\/?$/i;
/** GET /session/:sessionId/stream — the open guest reattach (a long-held SSE). */
export const GUEST_STREAM_ATTACH_PATH_RE = /^\/session\/[^/]+\/stream\/?$/i;

export function rateLimitPathNormalizeDisabled(): boolean {
  return process.env.RATE_LIMIT_PATH_NORMALIZE_DISABLED === '1';
}

type PathRequest = { path: string };

/** The /stream limiter's skip: true for every request that is not /stream. */
export function streamLimiterSkip(req: PathRequest): boolean {
  return rateLimitPathNormalizeDisabled() ? req.path !== '/stream' : !STREAM_LIMIT_PATH_RE.test(req.path);
}

/** The /upload limiter's skip: true for every request that is not /upload. */
export function uploadLimiterSkip(req: PathRequest): boolean {
  return rateLimitPathNormalizeDisabled() ? req.path !== '/upload' : !UPLOAD_LIMIT_PATH_RE.test(req.path);
}

/** The guest reattach limiters' skip: true for every request that is not GET /session/:id/stream. */
export function guestStreamAttachLimiterSkip(req: PathRequest): boolean {
  return !GUEST_STREAM_ATTACH_PATH_RE.test(req.path);
}

type ClientRequest = Parameters<typeof clientIpForHash>[0];

/** The hashed client ip (QUOTA_TRUSTED_PROXY_HOPS-anchored), or null when there is none. Never the raw ip. */
export function hashedClientKey(req: ClientRequest): string | null {
  return hashIp(clientIpForHash(req));
}

/** The per-client bucket of the guest reattach limiter. */
export function guestStreamAttachLimiterKey(req: ClientRequest): string {
  return `c:${hashedClientKey(req) ?? 'noip'}`;
}
