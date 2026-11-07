/**
 * SCIM 2.0 provisioning-token management (Phase 3 Enterprise, todo 76113a98).
 *
 * The tenant-facing half: an OWNER mints / rotates / revokes the bearer credentials
 * their IdP's provisioning client presents to /scim/v2/*. Mounted BEHIND the app
 * guard (a signed-in human), unlike scim.routes.ts which self-authenticates with
 * the token itself.
 *
 * ── WHY MINTING IS OWNER-ONLY (`scim:manage`) ───────────────────────────────
 * A SCIM token can CREATE ACCOUNTS. If an ADMIN could mint one, they would have
 * found the path around `member:grant-senior`: they cannot mint a peer OWNER via
 * the member routes, but they could issue themselves a provisioning credential
 * and provision accounts with it. Withholding mint from ADMIN keeps the
 * escalation chain broken at the same link. See the capability's doc comment.
 *
 * ── THE RAW TOKEN IS SHOWN ONCE ─────────────────────────────────────────────
 * Only sha256(token) is stored, exactly like agent tokens and email-verification
 * tokens. The raw value appears in the mint/rotate RESPONSE and never again — a
 * database read cannot mint a working credential, and no read route returns it.
 *
 * ── ROTATION IS ONE WRITE, NOT TWO ──────────────────────────────────────────
 * Rotate rewrites `tokenHash` IN PLACE on the same row. That means the previous
 * secret stops verifying the instant the update lands: there is no window where
 * both secrets work, and no failure mode where the old row lingers live because
 * a second delete failed. The old token's identity (id, name, scopes, history)
 * is preserved, which is what an operator rotating a credential expects.
 */
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AuthRequest } from '../../../middleware/auth';
import { AppError } from '../../../middleware/app-error';
import { validate } from '../../../middleware/validate';
import { requireOrgCapability } from './org-access';
import { SCIM_SCOPES, generateScimToken } from './scim-auth';

export const scimTokenRoutes = Router();

const orgIdSchema = z.object({ params: z.object({ orgId: z.string().uuid() }) });
const tokenParamsSchema = z.object({
  params: z.object({ orgId: z.string().uuid(), tokenId: z.string().uuid() }),
});

/** The caller's user id, or a 401 (the guard ran, so absence is a bug). */
function callerId(req: AuthRequest): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'Authentication required');
  return id;
}

/** What a read may return. NEVER tokenHash — it is a credential-equivalent. */
const TOKEN_READ_FIELDS = {
  id: true,
  name: true,
  tokenPrefix: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  rotatedAt: true,
  createdAt: true,
} as const;

const mintSchema = z.object({
  params: z.object({ orgId: z.string().uuid() }),
  body: z.object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.enum(SCIM_SCOPES)).min(1, 'at least one scope is required'),
    /** Days until expiry. Omitted = non-expiring (revocable at any time). */
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  }),
});

const rotateSchema = z.object({
  params: z.object({ orgId: z.string().uuid(), tokenId: z.string().uuid() }),
  body: z.object({ expiresInDays: z.number().int().min(1).max(3650).optional() }).optional(),
});

/** GET /orgs/:orgId/scim/tokens — list credentials, never the secrets. */
scimTokenRoutes.get('/orgs/:orgId/scim/tokens', validate(orgIdSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId } = req.params as { orgId: string };
    await requireOrgCapability(userId, orgId, 'scim:manage');
    const tokens = await prisma.scimToken.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      select: TOKEN_READ_FIELDS,
    });
    res.json({ success: true, data: { tokens, count: tokens.length } });
  } catch (error) {
    next(error);
  }
});

/** POST /orgs/:orgId/scim/tokens — mint. The raw secret is returned ONCE. */
scimTokenRoutes.post('/orgs/:orgId/scim/tokens', validate(mintSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId } = req.params as { orgId: string };
    await requireOrgCapability(userId, orgId, 'scim:manage');
    const { name, scopes, expiresInDays } = req.body as {
      name: string;
      scopes: (typeof SCIM_SCOPES)[number][];
      expiresInDays?: number;
    };

    const { raw, tokenHash, tokenPrefix } = generateScimToken();
    const token = await prisma.scimToken.create({
      data: {
        organizationId: orgId,
        name,
        tokenHash,
        tokenPrefix,
        scopes,
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
        createdByUserId: userId,
      },
      select: TOKEN_READ_FIELDS,
    });
    // Content-free audit: which tenant, which label, which scopes. Never the secret.
    logger.info('scim: provisioning token minted', {
      source: 'scim',
      organizationId: orgId,
      tokenId: token.id,
      scopes,
      actorId: userId,
    });
    // `token` (raw) is in THIS response only. No read route can reproduce it.
    res.status(201).json({ success: true, data: { token, secret: raw } });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /orgs/:orgId/scim/tokens/:tokenId/rotate — issue a new secret for the SAME
 * credential row, invalidating the previous one in the same write.
 */
scimTokenRoutes.post('/orgs/:orgId/scim/tokens/:tokenId/rotate', validate(rotateSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId, tokenId } = req.params as { orgId: string; tokenId: string };
    await requireOrgCapability(userId, orgId, 'scim:manage');
    const { expiresInDays } = (req.body ?? {}) as { expiresInDays?: number };

    // Scoped by organizationId: a token id from another tenant is simply not
    // found here, so this cannot be used to rotate a stranger's credential.
    const existing = await prisma.scimToken.findFirst({
      where: { id: tokenId, organizationId: orgId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) throw new AppError(404, 'Provisioning token not found');
    if (existing.revokedAt) throw new AppError(409, 'This token is revoked — mint a new one instead');

    const { raw, tokenHash } = generateScimToken();
    const token = await prisma.scimToken.update({
      where: { id: existing.id },
      data: {
        tokenHash,
        rotatedAt: new Date(),
        // A rotation is also a fresh start for usage bookkeeping.
        lastUsedAt: null,
        ...(expiresInDays ? { expiresAt: new Date(Date.now() + expiresInDays * 86_400_000) } : {}),
      },
      select: TOKEN_READ_FIELDS,
    });
    logger.info('scim: provisioning token rotated', {
      source: 'scim',
      organizationId: orgId,
      tokenId: token.id,
      actorId: userId,
    });
    // The OLD secret stopped verifying when tokenHash was overwritten above.
    res.json({ success: true, data: { token, secret: raw } });
  } catch (error) {
    next(error);
  }
});

/** DELETE /orgs/:orgId/scim/tokens/:tokenId — revoke outright. */
scimTokenRoutes.delete('/orgs/:orgId/scim/tokens/:tokenId', validate(tokenParamsSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId, tokenId } = req.params as { orgId: string; tokenId: string };
    await requireOrgCapability(userId, orgId, 'scim:manage');

    const result = await prisma.scimToken.updateMany({
      where: { id: tokenId, organizationId: orgId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new AppError(404, 'Provisioning token not found');
    logger.info('scim: provisioning token revoked', {
      source: 'scim',
      organizationId: orgId,
      tokenId,
      actorId: userId,
    });
    // A revoked token answers 401 exactly like an unknown one, so nothing about
    // this outcome is observable to whoever holds it.
    res.json({ success: true, data: { revoked: true } });
  } catch (error) {
    next(error);
  }
});