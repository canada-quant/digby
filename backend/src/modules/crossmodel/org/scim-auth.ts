/**
 * SCIM 2.0 token authentication (Phase 3 Enterprise, todo 76113a98).
 *
 * A SCIM token is a per-ORG bearer credential an identity provider's
 * provisioning client presents to /scim/v2/*. It is NOT a user session: it names
 * its tenant up front, carries no refresh path, and is scoped to provisioning
 * only, so an IdP that leaks it cannot read chats, run code or touch billing.
 *
 * WHY THIS IS A SEPARATE MIDDLEWARE FROM `authenticate`. The app-level JWT guard
 * builds `req.user` from a token's claims and every org-scoped handler then
 * resolves membership from the `:orgId` in the path. A SCIM caller has neither:
 * no user, and (by design) no org in the path — the token IS the tenant. So this
 * runs in the OPEN section, self-authenticates per route, and sets `req.scim`.
 * That is the same shape platformRoutes uses for `dgt_` agent tokens.
 *
 * THE 404-NOT-403 RULE, RESTATED FOR TOKENS. With the org bound to the token,
 * cross-tenant access is impossible by construction rather than by a check: a
 * token for org A has no way to NAME org B, because no SCIM route accepts an org
 * parameter. A resource id belonging to another tenant is simply not found in
 * this tenant's scope and answers 404. That is the strongest form of the posture
 * org-access.ts establishes — there is no branch where the org id could differ
 * from the token's, so there is nothing to get wrong.
 *
 * WHAT IS DELIBERATELY NOT LEAKED ON FAILURE. Unknown, revoked and expired
 * tokens all answer the same 401 with the same body. A distinct "revoked"
 * response would let a probe distinguish "this credential existed" from "never
 * existed", which is the same existence-oracle class the 404 rule closes.
 */
import { Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import type { AuthRequest } from '../../../middleware/auth';

/** All scopes a SCIM token may carry. */
export const SCIM_SCOPES = [
  /** List/read Users. */
  'users:read',
  /** Create/update/deactivate Users. */
  'users:write',
  /** List/read Groups. */
  'groups:read',
  /** Create/update/delete Groups. */
  'groups:write',
] as const;
export type ScimScope = (typeof SCIM_SCOPES)[number];

export const SCIM_TOKEN_PREFIX = 'scim_';

/** Prefix length kept in `tokenPrefix` for UI identification ("scim_ab12cd34…"). */
const PREFIX_KEEP = 13;

/** Where the tokens router and the audit trail refer to this credential. */
export interface ScimAuthContext {
  tokenId: string;
  organizationId: string;
  scopes: string[];
}

export interface ScimRequest extends AuthRequest {
  scim?: ScimAuthContext;
}

export function hashScimToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** A fresh secret. 24 random bytes => 48 hex chars; the raw value is shown ONCE. */
export function generateScimToken(): { raw: string; tokenHash: string; tokenPrefix: string } {
  const raw = SCIM_TOKEN_PREFIX + randomBytes(24).toString('hex');
  return { raw, tokenHash: hashScimToken(raw), tokenPrefix: raw.slice(0, PREFIX_KEEP) };
}

/** RFC 7644 §3.12 error body. SCIM clients parse THIS shape, not `{ error }`. */
export function scimError(res: Response, status: number, detail: string): void {
  res.status(status).json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail,
    status: String(status),
  });
}

/** Throwable form, for handlers that route errors through `next`. */
export class ScimError extends AppError {
  constructor(status: number, detail: string) {
    super(status, detail);
    Object.setPrototypeOf(this, ScimError.prototype);
  }
}

/**
 * Throttle `lastUsedAt` writes: a busy IdP polls, and a write per request would
 * put a row update on every sync call. One per token per minute is enough to
 * answer "is this credential still in use?".
 */
const LAST_USED_WRITE_THROTTLE_MS = 60_000;

/**
 * Resolve a presented bearer value to a live token, or null.
 *
 * A token is LIVE when the hash matches, it is not revoked, and it has not
 * expired. Everything else is null — the caller must not be able to tell which.
 */
async function resolveScimToken(rawToken: string): Promise<ScimAuthContext | null> {
  if (!rawToken.startsWith(SCIM_TOKEN_PREFIX)) return null;
  const row = await prisma.scimToken.findUnique({
    where: { tokenHash: hashScimToken(rawToken) },
    select: { id: true, organizationId: true, scopes: true, revokedAt: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Fire-and-forget: a failed bookkeeping write must never fail the request the
  // IdP is waiting on. Throttled so a polling client cannot hammer the row.
  void prisma.scimToken
    .updateMany({
      where: {
        id: row.id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - LAST_USED_WRITE_THROTTLE_MS) } }],
      },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => undefined);

  return { tokenId: row.id, organizationId: row.organizationId, scopes: row.scopes };
}

/** Extract a bearer value from the Authorization header, or null. */
function bearerFrom(req: ScimRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const value = header.slice('Bearer '.length).trim();
  return value || null;
}

/**
 * Authenticate a SCIM request. Runs in the OPEN section, per router.
 *
 * Always 401 on any failure — see the header on why "revoked" is not its own
 * answer.
 */
export async function authenticateScim(
  req: ScimRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const presented = bearerFrom(req);
    if (!presented) {
      scimError(res, 401, 'Authentication required');
      return;
    }
    const ctx = await resolveScimToken(presented);
    if (!ctx) {
      // One line, content-free: never the token, never which failure it was.
      logger.warn('scim: rejected a provisioning credential', { source: 'scim' });
      scimError(res, 401, 'Authentication required');
      return;
    }
    req.scim = ctx;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Gate a route on a scope. A token missing the scope gets 403 — at this point the
 * caller has already proven it holds a live credential for a tenant, so there is
 * no tenancy fact left to hide (the same reasoning org-access.ts uses for a
 * member who lacks a capability).
 */
export function requireScimScope(scope: ScimScope) {
  return (req: ScimRequest, res: Response, next: NextFunction): void => {
    const ctx = req.scim;
    if (!ctx) {
      scimError(res, 401, 'Authentication required');
      return;
    }
    if (!ctx.scopes.includes(scope)) {
      logger.warn('scim: token lacks a required scope', { source: 'scim', scope });
      scimError(res, 403, `This provisioning credential does not grant ${scope}`);
      return;
    }
    next();
  };
}

/** The authenticated context, or a 401 (the guard ran, so absence is a bug). */
export function scimContext(req: ScimRequest): ScimAuthContext {
  const ctx = req.scim;
  if (!ctx) throw new ScimError(401, 'Authentication required');
  return ctx;
}