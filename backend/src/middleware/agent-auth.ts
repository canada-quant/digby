/**
 * Platform unification (P3) — agent-token authentication for the external
 * platform REST API (/api/crossmodel/platform).
 *
 * `authenticatePlatform` accepts EITHER caller type:
 *   1. User JWT (the existing `authenticate` logic) → req.user as today and
 *      req.agentScopes = null, meaning FULL access (scope checks pass).
 *   2. An agent token — a Bearer token starting `dgt_`, minted in Account
 *      settings. Only its sha256 hash is stored (agent_tokens.tokenHash).
 *      Resolved to the token's user (same req.user shape as the JWT path) +
 *      req.agentScopes = token.scopes. Missing/unknown, revoked, and expired
 *      tokens are rejected with 401.
 *
 * `requireScope(...scopes)` then gates a route: JWT callers (agentScopes null)
 * always pass; agent-token callers need EVERY required scope or get
 * 403 { error: 'insufficient_scope', required }.
 *
 * Scope names: chats:read, chats:write, folders:read, folders:write,
 * schedules:write, code:run.
 */

import { Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import prisma from '../config/database';
import logger from '../utils/logger';
import { logHandled } from '../utils/log-level';
import { verifyAccessToken } from '../utils/jwt';
import { AuthRequest, PASSWORD_CHANGED_401 } from './auth';
import { buildInvalidTokenSample, recordInvalidTokenSignal, isDeadTokenShape } from './auth-signal';
import { isRevokedByPasswordChange } from '../modules/auth/password-change-cutoff';

/** All scopes an agent token can carry (zod enum source of truth). */
export const AGENT_TOKEN_SCOPES = [
  'chats:read',
  'chats:write',
  'folders:read',
  'folders:write',
  'schedules:write',
  'code:run',
] as const;
export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number];

export interface PlatformRequest extends AuthRequest {
  /**
   * null  → authenticated via user JWT → full access (scope checks pass).
   * array → authenticated via agent token → only these scopes.
   */
  agentScopes?: string[] | null;
}

export const AGENT_TOKEN_PREFIX = 'dgt_';

/** Throttle lastUsedAt writes: at most one update per token per 60s. */
const LAST_USED_WRITE_THROTTLE_MS = 60_000;

export function hashAgentToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export const authenticatePlatform = async (
  req: PlatformRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  const token = authHeader.substring(7);

  // ── Agent token path ──────────────────────────────────────────────────────
  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    try {
      const record = await prisma.agentToken.findUnique({
        where: { tokenHash: hashAgentToken(token) },
      });
      if (!record) {
        res.status(401).json({ error: 'Invalid agent token' });
        return;
      }
      if (record.revokedAt) {
        res.status(401).json({ error: 'Agent token has been revoked' });
        return;
      }
      if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
        res.status(401).json({ error: 'Agent token has expired' });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: record.userId } });
      if (!user || !user.isActive) {
        res.status(401).json({ error: 'Agent token owner not found' });
        return;
      }

      // Same req.user shape as the JWT path (authenticate in middleware/auth.ts).
      req.user = {
        id: user.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        isChild: user.isChild,
        parentId: user.parentId,
      };
      req.agentScopes = record.scopes;

      // Fire-and-forget lastUsedAt, throttled to one write per 60s per token.
      if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > LAST_USED_WRITE_THROTTLE_MS) {
        prisma.agentToken
          .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
          .catch((err: any) => logger.warn(`agent token lastUsedAt update failed: ${err.message}`));
      }
      next();
    } catch (error) {
      logger.error('Agent token authentication error:', error);
      res.status(401).json({ error: 'Invalid agent token' });
    }
    return;
  }

  // ── User JWT path (mirrors authenticate in middleware/auth.ts) ───────────
  try {
    const payload = verifyAccessToken(token);
    // Change-password (2026-10-12): same cutoff as middleware/auth.ts.
    if (await isRevokedByPasswordChange(payload)) {
      res.status(401).json(PASSWORD_CHANGED_401);
      return;
    }
    req.user = { ...payload, id: payload.userId };
    req.agentScopes = null; // JWT = full access
    next();
  } catch (error) {
    // Same doctrine as middleware/auth.ts: expired/invalid client tokens are
    // routine client conditions — warn, not error (error-level floods drown
    // the ops signals the auto-fix/nightly scanners rely on, 2026-08-08).
    const errName = (error as Error)?.name;
    if (errName === 'TokenExpiredError' || errName === 'JsonWebTokenError') {
      // Expired (or a dead pre-rotation token past its exp) = stale session
      // (handled, info); invalid with a live expiry = possible forgery (warn).
      const stale = errName === 'TokenExpiredError' || isDeadTokenShape(token);
      if (stale) logHandled('Authentication failed (client token):', { error: (error as Error)?.message });
      else logger.warn('Authentication failed (client token):', error);
      // Invalid-signature spike counter (see middleware/auth-signal.ts) — keeps
      // forged-token floods visible to the error-level scanners.
      if (errName === 'JsonWebTokenError' && !stale) recordInvalidTokenSignal(req.ip, 'authenticatePlatform', buildInvalidTokenSample(req, token));
    } else {
      logger.error('Authentication error:', error);
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * Gate a route on agent-token scopes. JWT callers (agentScopes === null) always
 * pass; agent-token callers need every required scope.
 */
export const requireScope = (...scopes: AgentTokenScope[]) => {
  return (req: PlatformRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (req.agentScopes == null) {
      next(); // JWT → full access
      return;
    }
    const missing = scopes.filter((s) => !req.agentScopes!.includes(s));
    if (missing.length) {
      res.status(403).json({ error: 'insufficient_scope', required: scopes });
      return;
    }
    next();
  };
};

/**
 * Token-management routes are JWT-only: an agent token must NEVER mint, list,
 * or revoke tokens (a leaked token must not be able to mint more).
 */
export const rejectAgentToken = (
  req: PlatformRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.agentScopes != null) {
    res.status(403).json({ error: 'This route requires your account session' });
    return;
  }
  next();
};
