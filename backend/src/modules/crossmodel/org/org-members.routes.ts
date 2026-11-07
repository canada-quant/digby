/**
 * ORG-SCOPED membership routes (Phase 3 Enterprise RBAC, todo c45f065e).
 *
 * WHAT THIS IS: the tenant-facing counterpart of `org-admin.routes.ts`. Those
 * routes are INSTANCE-admin levers (suspend a tenant, set its limit) reachable
 * only by `isAdminViewer`; these are WORKSPACE routes, reachable by members of
 * one org and scoped to exactly that org. Two different questions ("is this
 * person an operator of this deployment?" vs "what may this person do inside
 * their own tenant?") and therefore two different gates — but only ONE
 * interpretation of `memberships.role`, which is `org-access.ts`.
 *
 * WHY EVERY HANDLER CALLS `requireOrgCapability` ITSELF. Mounted behind the
 * single app-level `authenticate` guard (app.ts order contract), so a caller here
 * is always signed in — but signed-in says nothing about WHICH org they may
 * touch. Authentication is resolved from the token; authorization is resolved
 * from the `:orgId` in the path against the database, on every request. No
 * router-level `router.use(...)` gate, because route-posture.test.ts pins that
 * pattern for routers mounted at this prefix, and because a per-handler call is
 * the only shape that makes the capability of each route readable in one line.
 *
 * THE 404-NOT-403 RULE lives in org-access.ts (see its header) and is the
 * isolation property of this whole file: a non-member gets "Workspace not
 * found", identical to a workspace id that was never created, so these routes
 * cannot be used to enumerate other tenants. A caller who IS a member but lacks
 * the capability gets a 403 — at that point they already know the org exists.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *  - No route creates or deletes an ORG. A personal org is created transactionally
 *    with the account (org.service.ensurePersonalOrg) and a team org's lifecycle
 *    is not a member-level decision.
 *  - No route lets an INSTANCE admin bypass the membership check. An operator
 *    already has /admin/orgs; making these routes admin-bypassable would turn a
 *    legitimate operator surface into a cross-tenant read oracle for anyone who
 *    gets that role.
 *  - No self-service "leave workspace" route. Removal is an administrative act
 *    here; leaving is a different (auditable, confirmation-gated) flow and
 *    overloading DELETE with it is how people accidentally leave their own org.
 */
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AuthRequest } from '../../../middleware/auth';
import { AppError } from '../../../middleware/app-error';
import { validate } from '../../../middleware/validate';
import {
  DEFAULT_MEMBER_ORG_ROLE,
  ORG_ROLES,
  isOwnerRole,
  outranksForMemberAction,
  requireOrgCapability,
  requiresSeniorGrant,
  resolveMembership,
  type OrgCapability,
} from './org-access';

export const orgMembersRoutes = Router();

/** The org columns these routes may return. Never the roster, never usage rows. */
const ORG_FIELDS = {
  id: true,
  name: true,
  slug: true,
  plan: true,
  personal: true,
  createdAt: true,
} as const;

/** The member columns — the user's display identity, never their email/credentials. */
const MEMBER_FIELDS = {
  userId: true,
  role: true,
  isDefault: true,
  createdAt: true,
  user: { select: { id: true, name: true, firstName: true, lastName: true, avatar: true } },
} as const;

/** The caller's user id, or a 401 — the guard ran, so a missing user is a bug, not anonymous. */
function callerId(req: AuthRequest): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'Authentication required');
  return id;
}

/**
 * Load the org a caller has ALREADY proven membership of. Kept separate from the
 * capability gate because the gate answers "may you act here" and this answers
 * "what is here" — and because `personal` decides whether member management is
 * even meaningful (a personal org is single-member BY CONSTRUCTION, so adding a
 * second member would silently convert the user's private context into a shared
 * tenant, which is a product decision nobody made).
 */
async function loadOrgForMembership(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true, personal: true, plan: true },
  });
  if (!org) throw new AppError(404, 'Workspace not found');
  return org;
}

/** Refuse member management in a personal org (400 — the caller DOES have the capability). */
function refusePersonalOrg(org: { personal: boolean }): void {
  if (org.personal) {
    throw new AppError(
      400,
      'A personal workspace is single-member by design and cannot be shared. Create a team workspace to manage members.',
    );
  }
}

/** Every role the API accepts, taken from the SAME tuple the capability table is validated against. */
const roleSchema = z.enum(ORG_ROLES);

const orgIdSchema = z.object({
  params: z.object({ orgId: z.string().min(1, 'orgId is required') }),
});

const memberParamsSchema = z.object({
  params: z.object({
    orgId: z.string().min(1, 'orgId is required'),
    userId: z.string().min(1, 'userId is required'),
  }),
});

const inviteSchema = z.object({
  params: z.object({ orgId: z.string().min(1, 'orgId is required') }),
  body: z.object({
    /** Normalized (trim + lowercase) here so the same human always resolves to one account. */
    email: z.string().trim().min(3).max(320).email('A valid email is required'),
  }),
});

const roleChangeSchema = z.object({
  params: z.object({
    orgId: z.string().min(1, 'orgId is required'),
    userId: z.string().min(1, 'userId is required'),
  }),
  body: z.object({ role: roleSchema }),
});

/**
 * Gate + target lookup for the two routes that act on one existing member.
 * Returns the target's membership; 404 when that user is not in this org (a
 * non-member target is indistinguishable from an unknown one, the same
 * no-oracle rule as the tenant check).
 */
async function requireTargetMember(orgId: string, targetUserId: string) {
  const target = await resolveMembership(targetUserId, orgId);
  if (!target) throw new AppError(404, 'That person is not a member of this workspace');
  return target;
}

/**
 * The rank rule: nobody acts on a peer or a superior. Equal ranks are refused on
 * purpose (an ADMIN cannot remove another ADMIN), so removing people always
 * requires someone strictly senior — which caps what a single compromised admin
 * account can dismantle. The OWNER-acts-on-OWNER exception lives in
 * `outranksForMemberAction` (org-access.ts) with its reasoning.
 */
function refuseEqualOrHigher(actorRole: string, targetRole: string, action: string): void {
  if (!outranksForMemberAction(actorRole, targetRole)) {
    throw new AppError(403, `You cannot ${action} a member whose role is equal to or above your own`);
  }
}

/**
 * @swagger
 * /api/crossmodel/orgs:
 *   get:
 *     summary: List the workspaces I belong to
 *     description: >
 *       The tenant-switcher surface. Scoped by the CALLER's userId, so it can
 *       never return a workspace the caller is not a member of — there is no
 *       parameter that widens it.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.get('/orgs', async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    // `where: { userId }` (never an orgId from the request) is the whole scoping
    // story for this route: the tenancy predicate is the caller's own identity.
    const memberships = await prisma.membership.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        role: true,
        isDefault: true,
        createdAt: true,
        organization: { select: ORG_FIELDS },
      },
    });
    const orgs = memberships.map((m) => ({
      ...m.organization,
      role: m.role,
      isDefault: m.isDefault,
      joinedAt: m.createdAt,
    }));
    return res.json({ success: true, data: { orgs, count: orgs.length } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/orgs/{orgId}:
 *   get:
 *     summary: Read one workspace
 *     description: >
 *       Requires org:read — held by EVERY role, because a user's sends bill
 *       against their org and the client has to render it. A caller who is not
 *       a member gets 404, never 403.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.get('/orgs/:orgId', validate(orgIdSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId } = req.params as { orgId: string };
    const membership = await requireOrgCapability(userId, orgId, 'org:read');
    const org = await loadOrgForMembership(orgId);
    return res.json({ success: true, data: { org, role: membership.role } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/orgs/{orgId}/members:
 *   get:
 *     summary: List a workspace's members
 *     description: >
 *       Requires member:read (OWNER/ADMIN). A plain MEMBER gets 403 — belonging
 *       to a tenant is not the same as being allowed to enumerate its people,
 *       which is a privacy decision rather than a convenience one.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.get('/orgs/:orgId/members', validate(orgIdSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId } = req.params as { orgId: string };
    await requireOrgCapability(userId, orgId, 'member:read');
    const members = await prisma.membership.findMany({
      where: { organizationId: orgId },
      orderBy: [{ createdAt: 'asc' }],
      select: MEMBER_FIELDS,
    });
    return res.json({ success: true, data: { members, count: members.length } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/orgs/{orgId}/members:
 *   post:
 *     summary: Add an existing user to a workspace
 *     description: >
 *       Requires member:invite. The invitee must already have an account (404
 *       otherwise — this is not an invitation-email flow). An existing member is
 *       409. A PERSONAL workspace refuses with 400: it is single-member by
 *       construction, and silently turning it into a shared tenant would change
 *       what the user's own data is exposed to. The new member always starts as
 *       MEMBER; promoting them is a separate, separately-gated act.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.post('/orgs/:orgId/members', validate(inviteSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId } = req.params as { orgId: string };
    const { email } = req.body as { email: string };
    await requireOrgCapability(userId, orgId, 'member:invite');
    const org = await loadOrgForMembership(orgId);
    refusePersonalOrg(org);

    // Case-insensitive because addresses are stored normalized at signup
    // (auth.service lowercases) but a human typing an invite will not be.
    const invitee = await prisma.user.findFirst({
      where: { email: { equals: email.toLowerCase(), mode: 'insensitive' } },
      select: { id: true, name: true, firstName: true, email: true },
    });
    if (!invitee) throw new AppError(404, 'No account found with that email address');

    const existing = await resolveMembership(invitee.id, orgId);
    if (existing) throw new AppError(409, 'That person is already a member of this workspace');

    // A DEPROVISIONED membership resolves as absent (see resolveMembership), but
    // the ROW still exists and `@@unique([userId, organizationId])` still holds
    // it. A plain create here would therefore throw a unique-constraint 500 the
    // first time an admin re-invites someone a SCIM deprovision removed. So look
    // for the deprovisioned row explicitly and REACTIVATE it: the same act the IdP
    // performs with `active:true`, and the outcome a human inviting them back
    // means. Re-adding is deliberately still gated on member:invite (already
    // checked above) and still lands on the least-power role.
    const deprovisioned = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: invitee.id, organizationId: orgId } },
      select: { id: true, deactivatedAt: true },
    });
    if (deprovisioned?.deactivatedAt) {
      const member = await prisma.membership.update({
        where: { id: deprovisioned.id },
        data: { deactivatedAt: null, role: DEFAULT_MEMBER_ORG_ROLE },
        select: MEMBER_FIELDS,
      });
      logger.info(`org-rbac: ${userId} reactivated deprovisioned user ${invitee.id} in org ${orgId}`);
      return res.status(201).json({ success: true, data: { member, reactivated: true } });
    }

    const member = await prisma.membership.create({
      // Least power by default: the shared constant, not a literal here, so the
      // "invites grant MEMBER" rule lives with the rest of the role semantics.
      data: { userId: invitee.id, organizationId: orgId, role: DEFAULT_MEMBER_ORG_ROLE, isDefault: false },
      select: MEMBER_FIELDS,
    });
    // Attributable, content-free: who added whom, to which tenant. Adding a
    // person to a tenant is exactly the kind of act that must survive an audit.
    logger.info(`org-rbac: ${userId} added user ${invitee.id} to org ${orgId} as ${DEFAULT_MEMBER_ORG_ROLE}`);
    return res.status(201).json({ success: true, data: { member } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/orgs/{orgId}/members/{userId}:
 *   patch:
 *     summary: Change a member's role
 *     description: >
 *       Requires member:role, plus OWNER for any change that involves OWNER or
 *       ADMIN (you may not mint a peer of yourself). Nobody may change their own
 *       role — that is the self-promotion and owner-demotion hole in one rule.
 *       Nobody may act on a member of equal or higher rank.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.patch('/orgs/:orgId/members/:userId', validate(roleChangeSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId, userId: targetUserId } = req.params as { orgId: string; userId: string };
    const { role: nextRole } = req.body as { role: (typeof ORG_ROLES)[number] };
    const actor = await requireOrgCapability(userId, orgId, 'member:role');

    // Self-change refused outright, BEFORE the rank rule: an ADMIN demoting the
    // owner (or promoting themselves) is the one escalation that needs no second
    // account, and rank comparison alone cannot express "not you".
    if (targetUserId === userId) {
      throw new AppError(400, 'You cannot change your own role in a workspace');
    }

    const target = await requireTargetMember(orgId, targetUserId);
    refuseEqualOrHigher(actor.role, target.role, 'change the role of');

    // Seniority changes (granting or revoking OWNER/ADMIN) are OWNER-only. The
    // capability is data in org-access.ts, so this route never names a role.
    if (requiresSeniorGrant(target.role, nextRole)) {
      await requireOrgCapability(userId, orgId, 'member:grant-senior');
    }

    // No-op guard: writing the same role would emit an audit line claiming a
    // change that did not happen.
    if (target.role === nextRole) {
      return res.json({ success: true, data: { member: { ...target } } });
    }

    const member = await prisma.membership.update({
      where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
      data: { role: nextRole },
      select: MEMBER_FIELDS,
    });
    logger.info(`org-rbac: ${userId} changed user ${targetUserId} in org ${orgId} from ${target.role} to ${nextRole}`);
    return res.json({ success: true, data: { member } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/orgs/{orgId}/members/{userId}:
 *   delete:
 *     summary: Remove a member from a workspace
 *     description: >
 *       Requires member:remove. The removed user's ACCOUNT is untouched — only
 *       the membership row is deleted, so they keep every chat, document and
 *       file they own. Nobody may remove a member of equal or higher rank, and
 *       the LAST OWNER can never be removed (400) so a workspace can never be
 *       left with nobody able to administer it. Personal workspaces refuse (400).
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
orgMembersRoutes.delete('/orgs/:orgId/members/:userId', validate(memberParamsSchema), async (req, res, next) => {
  try {
    const userId = callerId(req as AuthRequest);
    const { orgId, userId: targetUserId } = req.params as { orgId: string; userId: string };
    const actor = await requireOrgCapability(userId, orgId, 'member:remove');
    const org = await loadOrgForMembership(orgId);
    refusePersonalOrg(org);
    const target = await requireTargetMember(orgId, targetUserId);

    // LAST-OWNER INVARIANT — checked BEFORE the rank rule on purpose. It is a
    // property of the WORKSPACE, not of the caller: an org with no OWNER is
    // unrecoverable through this API, and the answer "this would orphan the
    // workspace" is more accurate than a rank 403 for a state that must never be
    // reached at all. Both responses are only visible to a member who already
    // holds member:remove, so this ordering leaks nothing across tenants.
    if (isOwnerRole(target.role)) {
      const owners = await prisma.membership.count({ where: { organizationId: orgId, role: 'OWNER' } });
      if (owners <= 1) {
        throw new AppError(
          400,
          'A workspace must keep at least one OWNER — promote another member to OWNER before removing this one',
        );
      }
    }

    refuseEqualOrHigher(actor.role, target.role, 'remove');

    await prisma.membership.delete({
      where: { userId_organizationId: { userId: targetUserId, organizationId: orgId } },
    });
    logger.info(`org-rbac: ${userId} removed user ${targetUserId} (${target.role}) from org ${orgId}`);
    return res.json({ success: true, data: { removed: { userId: targetUserId, role: target.role } } });
  } catch (error) {
    return next(error);
  }
});

export default orgMembersRoutes;

/** Route → capability map, exported so a future doc/UI and the structural test can read ONE source. */
export const ORG_MEMBER_ROUTE_CAPABILITIES: ReadonlyArray<{ method: string; path: string; capability: OrgCapability }> = [
  { method: 'get', path: '/orgs/:orgId', capability: 'org:read' },
  { method: 'get', path: '/orgs/:orgId/members', capability: 'member:read' },
  { method: 'post', path: '/orgs/:orgId/members', capability: 'member:invite' },
  { method: 'patch', path: '/orgs/:orgId/members/:userId', capability: 'member:role' },
  { method: 'delete', path: '/orgs/:orgId/members/:userId', capability: 'member:remove' },
];