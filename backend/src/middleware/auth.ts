import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { issueAccessCookie, clearAccessCookie } from '../modules/auth/auth-cookie';
import { buildInvalidTokenSample, recordInvalidTokenSignal, isDeadTokenShape } from './auth-signal';
import { expiredTokenNoise, EXPIRED_TOKEN_WINDOW_MS } from './token-noise';
import { isRevokedByPasswordChange } from '../modules/auth/password-change-cutoff';
import logger from '../utils/logger';
import { logHandled } from '../utils/log-level';

/** 401 body for an access token issued before the user's last password change. */
export const PASSWORD_CHANGED_401 = { error: 'Your password was changed. Please sign in again.', code: 'PASSWORD_CHANGED' };

export interface AuthRequest extends Request {
  user?: {
    id: string;
    userId: string;
    email: string;
    role: string;
    isChild?: boolean;
    parentId?: string | null;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let token: string | undefined;
  let fromBearer = false;
  try {
    const authHeader = req.headers.authorization;
    // Accept the token from the Authorization header (primary) OR the httpOnly
    // cm_access cookie (findings #8/#9 — keeps the JWT out of localStorage/URLs).
    fromBearer = !!authHeader?.startsWith('Bearer ');
    token = fromBearer
      ? authHeader!.substring(7)
      : (typeof (req as any).cookies?.cm_access === 'string' ? (req as any).cookies.cm_access : undefined);

    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const payload = verifyAccessToken(token);

    // Change-password (2026-10-12): an access token issued before the user's
    // last password change is dead. Fail-open on Redis trouble; never throws.
    if (await isRevokedByPasswordChange(payload)) {
      if (!fromBearer) clearAccessCookie(res);
      res.status(401).json(PASSWORD_CHANGED_401);
      return;
    }

    // Map userId to id for convenience
    req.user = {
      ...payload,
      id: payload.userId,
    };

    // Sliding re-issue (2026-07-23 "Chat not found" SSE fix): the cm_access
    // cookie holds a SHORT-LIVED access token (15m default) inside a 7-day
    // cookie, and was previously only re-set at login/register/refresh. The
    // EventSource SSE GET authenticates ONLY via that cookie, so a stale or
    // missing cookie made every authenticated stream arrive anonymous — and
    // the agentic cutover's ownership gate then 404'd the user's own chat.
    // Re-issuing on every Bearer-authenticated request keeps the cookie in
    // lockstep with the token the client is actually using (the frontend's
    // apiClient always carries Bearer). Safe: the client already presented
    // this exact token, and the cookie keeps its httpOnly/Secure/lax attrs.
    // issueAccessCookie replaces (never appends). authenticate now runs ONCE
    // per request via the single app-level guard in app.ts (the old per-router
    // router.use(authenticate) stacking re-ran it up to 8x on deep routes and
    // the duplicate Set-Cookie headers overflowed nginx's proxy buffer —
    // /coding/* 502s, 2026-07-23); replace-not-append stays as defense-in-depth.
    issueAccessCookie(res, token);

    next();
  } catch (error) {
    // Expected client conditions are not server errors: with short-lived access
    // tokens a lapsed token is routine, and one stuck client retrying the same
    // expired token flooded app_error_logs at level=error (~3.5k rows/48h = 44%
    // of ALL error volume, 2026-08-08) — drowning the real ops signals that the
    // error-level scanners (auto-fix triage, nightly telemetry) rely on.
    const errName = (error as Error)?.name;
    if (errName === 'TokenExpiredError' || errName === 'JsonWebTokenError') {
      const stale = errName === 'TokenExpiredError' || isDeadTokenShape(token);
      // Loop #19: ONE warn per token fingerprint per window — a stuck client
      // re-presenting the same expired token every 38 s produced 376 rows in
      // 4 h. Repeats log at debug; the first warn of the next window carries
      // the repeat count so the volume stays visible without the flood.
      const noise = token ? expiredTokenNoise(token) : { log: true, repeats: 0, fingerprint: '-' };
      const where = fromBearer ? 'bearer' : 'cookie';
      if (noise.log) {
        // A STALE session — an expired token, or a pre-rotation token whose
        // own exp is long past (it fails the signature check first) — is
        // handled (info, never stored in app_error_logs). This line, not the
        // error handler, carried most of the 2026-10-17 stale-browser noise.
        // An invalid token with a live expiry can be forgery and stays warn.
        const line = `Authentication failed (client token, ${where}${noise.repeats ? `; the same token was re-presented ${noise.repeats}× in the previous ${Math.round(EXPIRED_TOKEN_WINDOW_MS / 60000)} min` : ''}):`;
        if (stale) logHandled(line, { error: (error as Error)?.message, fingerprint: noise.fingerprint, repeats: noise.repeats });
        else logger.warn(line, error);
      } else {
        logger.debug(`Authentication failed (client token, ${where}, repeat #${noise.repeats} of fingerprint ${noise.fingerprint}):`, (error as Error)?.message);
      }
      // A token that arrived ONLY via the httpOnly cookie and has expired can
      // never be refreshed by the client from this side — the frontend drops
      // its localStorage copy on refresh failure but cannot touch this cookie.
      // Clear it so the browser stops re-presenting it on every poll.
      if (errName === 'TokenExpiredError' && !fromBearer) clearAccessCookie(res);
      // Expiry is routine; an INVALID token (bad signature / malformed) is the
      // forgery fingerprint — feed the rate-limited spike counter so sustained
      // floods still reach the error-level scanners despite the warn taxonomy.
      if (errName === 'JsonWebTokenError' && !stale) recordInvalidTokenSignal(req.ip, 'authenticate', buildInvalidTokenSample(req, token));
    } else {
      logger.error('Authentication error:', error);
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * Optional authentication — sets req.user if a valid Bearer token is present,
 * but always calls next() even if unauthenticated. Used for endpoints that
 * support both authenticated and anonymous access (e.g. the SSE stream).
 *
 * Checks (in order):
 *   1. Authorization: Bearer <token> header
 *   2. cm_access httpOnly cookie (EventSource sends it automatically same-origin
 *      — the launch-hardened path so the JWT is no longer in the SSE URL)
 *   3. ?token=<token> query param (legacy EventSource fallback; still accepted)
 */
export const optionalAuthenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = typeof (req as any).cookies?.cm_access === 'string' ? (req as any).cookies.cm_access : undefined;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const rawToken = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : (cookieToken || queryToken);

    if (rawToken) {
      try {
        const payload = verifyAccessToken(rawToken);
        // A token issued before the user's last password change: stay anonymous.
        if (await isRevokedByPasswordChange(payload)) throw new Error('revoked by password change');
        req.user = {
          ...payload,
          id: payload.userId,
        };
        // Sliding re-issue — same rationale as `authenticate` above: keeps the
        // SSE-auth cookie in lockstep with the live Bearer token. Covers the
        // /stream/register pre-registration (raw fetch with Bearer) so the
        // EventSource GET that follows it always has a fresh cookie.
        issueAccessCookie(res, rawToken);
      } catch {
        // Invalid token — continue as anonymous
      }
    }
  } catch (error) {
    // Swallow errors — continue unauthenticated
    logger.debug('Optional auth check failed, continuing anonymous:', error);
  }
  next();
};

/**
 * Digby Kids: reject child sub-account tokens from adult-only endpoints.
 * Child accounts are confined to the locked-down kid chat pipeline; everything
 * else (model-set, deep research, projects, integrations, memory, child
 * management) must 403 a child token. Apply AFTER authenticate.
 */
export const rejectChild = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.isChild) {
    res.status(403).json({ error: 'This feature is not available on a child account.', code: 'CHILD_ACCOUNT_FORBIDDEN' });
    return;
  }
  next();
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    next();
  };
};

// Alias for backward compatibility
export const auth = authenticate;
