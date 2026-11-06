/**
 * API URL prefixes — leg (b) PHASE 1 of the `crossmodel` → `digby` rename
 * (docs/LEG_B_CROSSMODEL_RENAME_PLAN.md §3).
 *
 * WHAT THIS IS: an ADDITIVE dual-serve. Every router and rate limiter that was
 * mounted at `/api/crossmodel` is mounted at exactly the same sub-path under
 * `/api/digby`, so both prefixes resolve to the same handlers. Nothing is
 * renamed, nothing is removed, and the old prefix stays canonical.
 *
 * WHY IT MUST BE A SINGLE SOURCE: the migration breaks if the two prefixes ever
 * diverge — a router added to one and forgotten on the other is a route that
 * works for one URL shape and 404s for the other, and it fails SILENTLY (no
 * compile error, no test unless something pins it). So app.ts may not mount a
 * crossmodel prefix directly any more; it mounts through `mountApi`, which
 * loops API_PREFIXES. `api-prefixes.test.ts` enforces that structurally.
 *
 * WHY THIS IS SAFE FOR EXISTING CLIENTS (the "zero behavior change" claim):
 *   - OAuth callback URLs are NOT derived from the request. Every controller
 *     builds `redirect_uri` from an env var or the `${frontendUrl}/api/crossmodel/…`
 *     literal (google/github/x/xero/slack/asana-oauth.controller.ts), so
 *     serving a second prefix cannot make us advertise an unregistered URI.
 *     A provider keeps redirecting to the URI registered in its console, which
 *     is the `/api/crossmodel/…` one — still mounted, still canonical.
 *   - Cookies are already `path: '/'` (auth-cookie.ts), not path-scoped to the
 *     old prefix, so no cookie stops being sent.
 *   - `req.originalUrl` consumers (auth-signal path attribution,
 *     credential-proxy's query passthrough) treat the prefix as an opaque
 *     string; neither branches on its value.
 *   - The router internals are prefix-agnostic: Express strips the mount path
 *     before it reaches the router (`req.baseUrl` is informational here and no
 *     non-test code reads it), so mounting the same router twice is exactly
 *     the same code running with a different prefix already removed.
 *
 * ORDER MATTERS AND IS PRESERVED: the `/api/crossmodel` mount order is a
 * contract (see the block comment in app.ts — OPEN routers must precede THE
 * single `authenticate` guard, authed routers must follow it). `mountApi` is
 * called once per site in that same statement order, so each prefix sees its
 * mounts in identical order; the two prefixes interleave, which is harmless
 * because Express matches on path and a request carries exactly one prefix.
 *
 * RATE LIMITERS SHARE ONE BUDGET ON PURPOSE: the limiter instances are created
 * once and passed to both prefixes, and they key on IP/chatId in Redis, not on
 * the path. Reusing the instance means the second prefix cannot double an
 * attacker's allowance (creating per-prefix instances would have done exactly
 * that — a rename would have quietly raised every limit by 2x).
 */
import type { Application, RequestHandler } from 'express';

/**
 * The prefix that stays CANONICAL through phase 1 — every URL we emit, every
 * registered OAuth callback and every existing client keeps using this one.
 * Listed first so mount order reads old-then-new.
 */
export const CANONICAL_API_PREFIX = '/api/crossmodel';

/**
 * The new prefix, served additively from phase 1. Operators can move their
 * provider consoles to it on their own schedule (or never) — that is the whole
 * point of the dual-serve window.
 */
export const ALIAS_API_PREFIX = '/api/digby';

/** Canonical first. `mountApi` preserves this order for every mount site. */
export const API_PREFIXES = [CANONICAL_API_PREFIX, ALIAS_API_PREFIX] as const;

export type ApiPrefix = (typeof API_PREFIXES)[number];

/**
 * Mount the same middleware stack at `subPath` under EVERY API prefix, in
 * API_PREFIXES order.
 *
 *   mountApi(app, '', crossmodelRoutes)          // /api/{crossmodel,digby}
 *   mountApi(app, '/platform', platformRoutes)   // /api/{crossmodel,digby}/platform
 *   mountApi(app, '', authenticate)              // the single guard, both prefixes
 *
 * Handlers are passed through by reference (not cloned), which is what keeps a
 * shared rate-limit store / budget across the prefixes.
 */
export const mountApi = (
  app: Application,
  subPath: string,
  ...handlers: RequestHandler[]
): void => {
  for (const prefix of API_PREFIXES) {
    app.use(`${prefix}${subPath}`, ...handlers);
  }
};