/**
 * Org/tenant ADMIN routes (Phase 2 Cloud, todo ea95fa0b leg 1 items 2 + 4).
 *
 * WHY THIS FILE EXISTS: the leg-1 work shipped the tenant MODEL but not the
 * operator surfaces that make it usable. Two controls were readable and had no
 * writer anywhere in the tree:
 *
 *   - `organizations.suspended` — org-quota.service refuses every send from a
 *     suspended org (reason 'suspended'), but until setOrgSuspension there was
 *     no function to set it and, after it, no ROUTE to reach it. An abuse
 *     control an operator cannot apply is not a control.
 *   - `organizations.dailyMessageLimit` — read by the quota guard, set by
 *     nothing. Every org is NULL (= unlimited), so the free tier's limit could
 *     be read but never decided.
 *
 * Both are fixed here at ONE admin surface, so "enforce the free tier" and
 * "stop an abusive tenant" are actions an operator can actually take from the
 * app rather than from psql.
 *
 * MOUNTED BEHIND the single app-level `authenticate` guard (app.ts order
 * contract). Each handler applies the admin gate itself via isAdminViewer —
 * the same ONE predicate the crossmodel.controller admin handlers use (ADMIN
 * role, or the owner e-mail on PRODUCTION only; on a self-host instance the
 * ADMIN role is the only authority). No router-level `router.use(...)` gate:
 * route-posture.test.ts pins that open routers stay fall-through-safe, and the
 * per-handler pattern matches visitors/reports.
 *
 * DELIBERATELY NOT HERE: creating or deleting orgs. A user's personal org is
 * created transactionally with the account (org.service.ensurePersonalOrg) and
 * must not be deletable out from under its members. Suspension is the
 * reversible, history-preserving lever — it never removes a member, never
 * deletes usage rows, and can be lifted.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AuthRequest } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import { isAdminViewer } from '../view/view-mode';
import { setOrgSuspension, setOrgDailyLimit } from './org.service';

export const orgAdminRoutes = Router();

/** The ONE admin predicate (see the file header). 403s without a user. */
function forbidUnlessAdmin(req: AuthRequest, res: Response): boolean {
  const user = req.user;
  if (!user || user.isChild === true || !isAdminViewer(user as any)) {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return true;
  }
  return false;
}

const listOrgsSchema = z.object({
  query: z.object({
    q: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const suspensionSchema = z.object({
  params: z.object({ orgId: z.string().min(1, 'orgId is required') }),
  body: z.object({
    suspended: z.boolean(),
    /** Required when suspended === true — enforced in setOrgSuspension (400). */
    reason: z.string().max(500).nullish(),
  }),
});

const quotaSchema = z.object({
  params: z.object({ orgId: z.string().min(1, 'orgId is required') }),
  body: z.object({
    /** null clears the limit back to unlimited (the self-host posture). */
    dailyMessageLimit: z.number().int().min(0).max(100000).nullable(),
  }),
});

/**
 * @swagger
 * /api/crossmodel/admin/orgs:
 *   get:
 *     summary: List workspaces (admin only)
 *     description: >
 *       Operator discovery surface for the tenant controls below — the free-tier
 *       limit and the abuse suspension both act on an org id, so an operator
 *       needs a way to find one. Supports a case-insensitive q over name/slug.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgAdminRoutes.get('/admin/orgs', validate(listOrgsSchema), async (req, res, next) => {
  try {
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const { q, limit } = (req as AuthRequest).query as { q?: string; limit?: number };
    const orgs = await prisma.organization.findMany({
      ...(q
        ? {
            where: {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { slug: { contains: q, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
      orderBy: { createdAt: 'desc' },
      take: limit ?? 50,
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        personal: true,
        suspended: true,
        suspendedReason: true,
        dailyMessageLimit: true,
        createdAt: true,
      },
    });
    return res.json({ success: true, data: { orgs, count: orgs.length } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/admin/orgs/{orgId}/suspension:
 *   put:
 *     summary: Suspend or reinstate a workspace (admin only)
 *     description: >
 *       Throws the per-tenant kill switch the quota guard already honours — a
 *       suspended org's members can still sign in and read their data, they
 *       simply cannot send. Reversible: suspended=false clears the reason so a
 *       lifted suspension leaves no stale explanation behind. A reason is
 *       REQUIRED when suspending (400 otherwise).
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgAdminRoutes.put('/admin/orgs/:orgId/suspension', validate(suspensionSchema), async (req, res, next) => {
  try {
    const admin = (req as AuthRequest).user;
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const { orgId } = req.params as { orgId: string };
    const { suspended, reason } = req.body as { suspended: boolean; reason?: string | null };
    const org = await setOrgSuspension(orgId, suspended, reason ?? null);
    // Audit: an abuse action against a tenant is exactly the kind of thing that
    // must be attributable later. Never logs free-text beyond the operator's own
    // reason, and never the target's content.
    logger.warn(
      `org-admin: ${suspended ? 'SUSPENDED' : 'reinstated'} org ${org.id} (${org.slug}) by ${admin?.id ?? 'unknown'}${suspended ? ` — reason: ${org.suspendedReason}` : ''}`,
    );
    return res.json({ success: true, data: { org } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/admin/orgs/{orgId}/quota:
 *   put:
 *     summary: Set a workspace's daily message limit (admin only)
 *     description: >
 *       Decides the free tier for one tenant. A number meters sends per UTC day
 *       through org-quota.service; null restores UNLIMITED, which is the
 *       self-host and pre-existing-account posture. 0 is a valid hard stop.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgAdminRoutes.put('/admin/orgs/:orgId/quota', validate(quotaSchema), async (req, res, next) => {
  try {
    const admin = (req as AuthRequest).user;
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const { orgId } = req.params as { orgId: string };
    const { dailyMessageLimit } = req.body as { dailyMessageLimit: number | null };
    const org = await setOrgDailyLimit(orgId, dailyMessageLimit);
    logger.info(
      `org-admin: quota for org ${org.id} (${org.slug}) set to ${org.dailyMessageLimit ?? 'UNLIMITED'} by ${admin?.id ?? 'unknown'}`,
    );
    return res.json({ success: true, data: { org } });
  } catch (error) {
    return next(error);
  }
});

export default orgAdminRoutes;