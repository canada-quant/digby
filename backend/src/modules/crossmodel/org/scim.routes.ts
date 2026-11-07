/**
 * SCIM 2.0 provisioning routes (Phase 3 Enterprise, todo 76113a98).
 *
 * RFC 7644 / RFC 7643 shapes for the endpoints identity providers actually call:
 *   /scim/v2/ServiceProviderConfig   capability discovery (no scope needed)
 *   /scim/v2/Users                   list / create / read / replace / patch / delete
 *   /scim/v2/Groups                  same, for groups
 *
 * ── THE TENANT COMES FROM THE TOKEN, NEVER FROM THE URL ─────────────────────
 * No route here accepts an org parameter. That is not an oversight, it is the
 * strongest form of the 404-not-403 rule the org model rests on (org-access.ts):
 * a token for org A has no syntactic way to NAME org B, so cross-tenant access is
 * impossible by construction rather than by a check somebody could forget. A
 * resource id belonging to another tenant is simply not found in this tenant's
 * scope and answers 404 — indistinguishable from an id that never existed.
 *
 * ── SCIM CAN NEVER MINT AN OWNER ────────────────────────────────────────────
 * The role a provisioned user receives is clamped by the SAME table the SSO JIT
 * path uses (`isJitAssignableRole` / `adaptiveJitRole` in org-sso.service.ts). A
 * SCIM token is a credential an IdP integration holds; if it could set an
 * arbitrary role, whoever controls that integration could hand themselves tenant
 * ownership through a provisioned account — the exact escalation the OWNER-only
 * `member:grant-senior` capability exists to prevent. So writes accept only
 * MEMBER/BILLING and everything else is coerced down, on WRITE and on READ.
 *
 * ── active:false IS A REAL DEPROVISION ──────────────────────────────────────
 * It sets `membership.deactivatedAt`, which `resolveMembership` treats as ABSENT
 * — so the user holds zero capabilities and every org-scoped route answers 404,
 * exactly as for a stranger. The User row and the membership row both SURVIVE:
 * SCIM removes ACCESS, it does not delete people, and `active:true` must be able
 * to reactivate. See the schema comment on `deactivatedAt`.
 *
 * ── THE LAST OWNER CANNOT BE DEPROVISIONED ──────────────────────────────────
 * Deactivating the final OWNER of a tenant would leave it with nobody able to
 * administer it — no member management, no IdP config, no recovery without
 * support. Refused 409 with an explanation rather than silently orphaning it.
 */
import { Router, json, type Response } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  authenticateScim,
  requireScimScope,
  scimContext,
  scimError,
  ScimError,
  type ScimRequest,
  type ScimScope,
} from './scim-auth';
import { adaptiveJitRole, isJitAssignableRole } from './org-sso.service';
import { isOwnerRole } from './org-access';

export const scimRoutes = Router();

/** RFC 7643 §3.1 / §3.2 schema URNs. */
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const SCIM_JSON = 'application/scim+json';

/**
 * IdPs send `application/scim+json`, which express.json does NOT parse by default
 * (it matches application/json only). Without this the body arrives undefined and
 * every create looks like an empty request — a silent, total failure of the whole
 * endpoint family. Parsed per-router so the global parser is untouched.
 */
scimRoutes.use(json({ type: [SCIM_JSON, 'application/json'], limit: '1mb' }));

/** SCIM responses should carry the SCIM media type (RFC 7644 §3.1). */
scimRoutes.use((_req, res, next) => {
  res.type(SCIM_JSON);
  next();
});

// ── Resource shapes (RFC 7643) ─────────────────────────────────────────────

type MembershipRow = {
  userId: string;
  organizationId: string;
  role: string;
  deactivatedAt: Date | null;
  scimExternalId: string | null;
  createdAt: Date;
  user: { id: string; email: string; name: string | null; firstName: string | null; lastName: string | null; isActive: boolean };
};

const MEMBERSHIP_SELECT = {
  userId: true,
  organizationId: true,
  role: true,
  deactivatedAt: true,
  scimExternalId: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true, firstName: true, lastName: true, isActive: true } },
} as const;

/** Absolute URL prefix for `meta.location`, honouring the deployed public base. */
function scimBase(): string {
  const base =
    process.env.API_PUBLIC_BASE_URL ||
    process.env.SCIM_PUBLIC_BASE_URL ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000';
  return `${base.replace(/\/+$/, '')}/api/crossmodel/scim/v2`;
}

/**
 * One membership as a SCIM User.
 *
 * `active` is the conjunction of the membership's deprovision state AND the
 * account's own `isActive` — a suspended Digby account must not read as active
 * just because its membership is fine.
 */
function toScimUser(m: MembershipRow) {
  const base = scimBase();
  const name = {
    ...(m.user.firstName ? { givenName: m.user.firstName } : {}),
    ...(m.user.lastName ? { familyName: m.user.lastName } : {}),
    ...(m.user.name ? { formatted: m.user.name } : {}),
  };
  return {
    schemas: [USER_SCHEMA],
    id: m.userId,
    ...(m.scimExternalId ? { externalId: m.scimExternalId } : {}),
    userName: m.user.email,
    // Digby has no separate display-name field; the roster shows name/firstName.
    ...(Object.keys(name).length ? { name } : {}),
    emails: [{ value: m.user.email, primary: true }],
    active: !m.deactivatedAt && m.user.isActive,
    // Not a SCIM role concept — surfaced as an enterprise extension so an admin
    // can SEE the tenant role without us inventing a group-to-role mapping.
    'urn:digby:params:scim:schemas:extension:2.0:OrgRole': { role: String(m.role) },
    meta: {
      resourceType: 'User',
      created: m.createdAt.toISOString(),
      location: `${base}/Users/${m.userId}`,
    },
  };
}

type GroupRow = {
  id: string;
  displayName: string;
  externalId: string | null;
  members: string[];
  createdAt: Date;
};

function toScimGroup(g: GroupRow) {
  const base = scimBase();
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    members: g.members.map((value) => ({ value, display: value })),
    meta: {
      resourceType: 'Group',
      created: g.createdAt.toISOString(),
      location: `${base}/Groups/${g.id}`,
    },
  };
}

/** RFC 7644 §3.4.2.4 ListResponse. */
function listResponse(res: Response, total: number, resources: unknown[], startIndex: number) {
  res.status(200).json({ schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });
}

/**
 * Parse `startIndex`/`count` (RFC 7644 §3.4.2.4). Both are 1-based / page-size;
 * absent means "from the start, everything the server feels like returning".
 */
function pagination(req: ScimRequest): { startIndex: number; count: number } {
  const q = req.query as Record<string, string | undefined>;
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1);
  const rawCount = Number.parseInt(q.count ?? '100', 10);
  // Cap the page so one caller cannot ask for the whole directory in a request.
  const count = Math.min(500, Math.max(0, Number.isFinite(rawCount) ? rawCount : 100));
  return { startIndex, count };
}

/**
 * Extract an RFC 7644 §3.4.2.2 filter's equality value for a given attribute.
 *
 * Only `attr eq "value"` is supported — that is what every mainstream IdP sends
 * (userName/displayName lookups). Anything more elaborate answers 400 rather
 * than silently ignoring the filter and returning the WHOLE directory, which
 * would be a data-disclosure bug dressed as leniency.
 */
function eqFilter(req: ScimRequest, attribute: string): string | null {
  const raw = (req.query as Record<string, string | undefined>).filter;
  if (!raw) return null;
  const match = /^\s*(\w+)\s+eq\s+"([^"]*)"\s*$/i.exec(raw);
  if (!match) {
    throw new ScimError(400, 'Only equality filters of the form attr eq "value" are supported');
  }
  if (match[1].toLowerCase() !== attribute.toLowerCase()) {
    throw new ScimError(400, `Filtering on "${match[1]}" is not supported`);
  }
  return match[2];
}

/** The role to store for a SCIM write, clamped exactly as the SSO JIT path clamps. */
function scimRole(raw: unknown): 'MEMBER' | 'BILLING' {
  if (typeof raw !== 'string') return 'MEMBER';
  const upper = raw.toUpperCase();
  if (!isJitAssignableRole(upper)) {
    // Coerce DOWN rather than refuse: an IdP that sends "OWNER" is making a
    // request we will never honour, and failing the whole provisioning run over
    // it would be worse than granting the least power. Logged so an operator can
    // see the misconfiguration.
    logger.warn('scim: role coerced to the assignable set', { source: 'scim', requested: upper });
    return 'MEMBER';
  }
  return adaptiveJitRole(upper) as 'MEMBER' | 'BILLING';
}

/** The caller's org, from the token. Never from the request. */
function orgOf(req: ScimRequest): string {
  return scimContext(req).organizationId;
}

/** Refuse to deprovision the last OWNER — that would orphan the tenant. */
async function assertNotLastOwner(organizationId: string, userId: string): Promise<void> {
  const target = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { role: true, deactivatedAt: true },
  });
  if (!target || target.deactivatedAt || !isOwnerRole(target.role)) return;
  const remaining = await prisma.membership.count({
    where: { organizationId, role: 'OWNER', deactivatedAt: null },
  });
  if (remaining <= 1) {
    throw new ScimError(
      409,
      'This is the last active OWNER of the workspace and cannot be deprovisioned — promote another owner first',
    );
  }
}

// ── ServiceProviderConfig (RFC 7643 §5) ────────────────────────────────────

scimRoutes.get('/ServiceProviderConfig', authenticateScim, (_req, res) => {
  res.status(200).json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://digby.ai/docs/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 500 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Per-workspace SCIM provisioning token', primary: true },
    ],
  });
});

// ── Users ──────────────────────────────────────────────────────────────────

scimRoutes.get('/Users', authenticateScim, requireScimScope('users:read'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const userName = eqFilter(req as ScimRequest, 'userName');
    const { startIndex, count } = pagination(req as ScimRequest);

    // Every query is scoped by organizationId — the tenancy predicate is the
    // token, so there is no path where a different org could be named.
    const where = {
      organizationId: orgId,
      ...(userName ? { user: { email: { equals: userName, mode: 'insensitive' as const } } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.membership.count({ where }),
      prisma.membership.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
        select: MEMBERSHIP_SELECT,
      }),
    ]);
    listResponse(res, total, rows.map((r) => toScimUser(r as MembershipRow)), startIndex);
  } catch (error) {
    next(error);
  }
});

scimRoutes.get('/Users/:id', authenticateScim, requireScimScope('users:read'), async (req, res, next) => {
  try {
    const row = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgOf(req as ScimRequest) } },
      select: MEMBERSHIP_SELECT,
    });
    // 404 for another tenant's user AND for a nonexistent one — the same answer,
    // so this cannot be used to probe membership of the deployment.
    if (!row) throw new ScimError(404, 'User not found');
    res.status(200).json(toScimUser(row as MembershipRow));
  } catch (error) {
    next(error);
  }
});

scimRoutes.post('/Users', authenticateScim, requireScimScope('users:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userName = typeof body.userName === 'string' ? body.userName.trim().toLowerCase() : '';
    if (!userName) throw new ScimError(400, 'userName is required');
    const externalId = typeof body.externalId === 'string' ? body.externalId : null;
    const name = (body.name ?? {}) as { givenName?: string; familyName?: string; formatted?: string };
    const role = scimRole(
      (body['urn:digby:params:scim:schemas:extension:2.0:OrgRole'] as { role?: unknown } | undefined)?.role ??
        (body.role as unknown),
    );

    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: userName, mode: 'insensitive' } },
      select: { id: true },
    });

    // A membership row may already exist (active or deprovisioned). Reuse it:
    // creating a second one would violate @@unique([userId, organizationId]).
    if (existingUser) {
      const existingMembership = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: existingUser.id, organizationId: orgId } },
        select: { userId: true },
      });
      if (existingMembership) {
        // Already provisioned — RFC 7644 §3.3 says return 409 with the existing
        // resource so the client can reconcile instead of duplicating.
        const row = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: existingUser.id, organizationId: orgId } },
          select: MEMBERSHIP_SELECT,
        });
        res.status(409).json({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          detail: 'User already exists in this workspace',
          status: '409',
          scimType: 'uniqueness',
          resource: row ? toScimUser(row as MembershipRow) : undefined,
        });
        return;
      }
    }

    // Create the user (if the address is new) and the membership together: a
    // membership with no user is a dangling FK, and a user with no membership
    // would be invisible to the IdP forever.
    const userId = await prisma.$transaction(async (tx) => {
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            email: userName,
            // No usable password: like an SSO-provisioned account, this one is
            // governed by its IdP. A random value nobody holds simply never
            // matches on the local login path.
            password: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
            name: name.formatted ?? null,
            firstName: name.givenName ?? null,
            lastName: name.familyName ?? null,
            // The IdP asserted this address, so it is verified by construction.
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        }));

      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: orgId,
          role,
          // Provisioning never repoints a person's DEFAULT billing org.
          isDefault: false,
          scimExternalId: externalId,
          // active defaults to true unless the client explicitly said otherwise.
          deactivatedAt: body.active === false ? new Date() : null,
        },
      });
      return user.id;
    });

    const row = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
      select: MEMBERSHIP_SELECT,
    });
    logger.info('scim: user provisioned', { source: 'scim', organizationId: orgId, userId, role });
    res.status(201).json(toScimUser(row as MembershipRow));
  } catch (error) {
    next(error);
  }
});

/** Shared apply for PUT (replace) and PATCH — sets the deprovision state safely. */
async function setActive(orgId: string, userId: string, active: boolean): Promise<void> {
  if (!active) await assertNotLastOwner(orgId, userId);
  await prisma.membership.update({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    data: { deactivatedAt: active ? null : new Date() },
  });
}

scimRoutes.put('/Users/:id', authenticateScim, requireScimScope('users:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const existing = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
      select: { userId: true },
    });
    if (!existing) throw new ScimError(404, 'User not found');

    // PUT is a full replace: the fields present are authoritative. `active`
    // absent means "unchanged" rather than "false", because treating an omitted
    // boolean as false would deprovision a user every time an IdP PUT without it.
    if (typeof body.active === 'boolean') {
      await setActive(orgId, req.params.id, body.active);
    }
    const name = (body.name ?? {}) as { givenName?: string; familyName?: string; formatted?: string };
    const userPatch: Record<string, unknown> = {};
    if (name.givenName !== undefined) userPatch.firstName = name.givenName;
    if (name.familyName !== undefined) userPatch.lastName = name.familyName;
    if (name.formatted !== undefined) userPatch.name = name.formatted;
    if (Object.keys(userPatch).length) {
      await prisma.user.update({ where: { id: req.params.id }, data: userPatch });
    }
    if (typeof body.externalId === 'string' || body.externalId === null) {
      await prisma.membership.update({
        where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
        data: { scimExternalId: (body.externalId as string | null) ?? null },
      });
    }

    const row = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
      select: MEMBERSHIP_SELECT,
    });
    res.status(200).json(toScimUser(row as MembershipRow));
  } catch (error) {
    next(error);
  }
});

scimRoutes.patch('/Users/:id', authenticateScim, requireScimScope('users:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const body = (req.body ?? {}) as { schemas?: string[]; Operations?: Operation[]; operations?: Operation[] };
    // RFC 7644 §3.5.2: the member is `Operations` (accept `operations` too —
    // several IdPs emit the lowercase form).
    const operations = body.Operations ?? body.operations ?? [];
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ScimError(400, 'A PATCH must carry at least one operation');
    }
    const existing = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
      select: { userId: true },
    });
    if (!existing) throw new ScimError(404, 'User not found');

    for (const op of operations) {
      const name = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '').toLowerCase();
      // `active` is the operation that matters: it is how every IdP deprovisions.
      if (path === 'active' || path === '') {
        const value = path === '' ? (op.value as Record<string, unknown> | undefined)?.active : op.value;
        if (typeof value === 'boolean') {
          await setActive(orgId, req.params.id, name === 'remove' ? false : value);
          continue;
        }
      }
      if (path === 'name.givenname' && typeof op.value === 'string') {
        await prisma.user.update({ where: { id: req.params.id }, data: { firstName: op.value } });
        continue;
      }
      if (path === 'name.familyname' && typeof op.value === 'string') {
        await prisma.user.update({ where: { id: req.params.id }, data: { lastName: op.value } });
        continue;
      }
      if (path === 'externalid') {
        await prisma.membership.update({
          where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
          data: { scimExternalId: typeof op.value === 'string' ? op.value : null },
        });
        continue;
      }
      // An unsupported path is a client error, not something to ignore: silently
      // dropping it would let an IdP believe a change landed when it did not.
      throw new ScimError(400, `Unsupported PATCH path "${op.path ?? ''}"`);
    }

    const row = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
      select: MEMBERSHIP_SELECT,
    });
    res.status(200).json(toScimUser(row as MembershipRow));
  } catch (error) {
    next(error);
  }
});

type Operation = { op?: string; path?: string; value?: unknown };

/**
 * DELETE /Users/:id — DEACTIVATE, never hard-delete.
 *
 * RFC 7644 lets a server choose how to satisfy a delete. Deleting the User row
 * would destroy a person's account (their chats, their own org) because an IdP
 * removed them from a tenant — catastrophic and irreversible. Deleting the
 * membership row would lose the deprovision state a subsequent GET must report
 * and make `active:true` impossible. So DELETE means exactly what `active:false`
 * means: access removed, records intact.
 */
scimRoutes.delete('/Users/:id', authenticateScim, requireScimScope('users:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const existing = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.params.id, organizationId: orgId } },
      select: { userId: true },
    });
    if (!existing) throw new ScimError(404, 'User not found');
    await setActive(orgId, req.params.id, false);
    logger.info('scim: user deprovisioned via DELETE', { source: 'scim', organizationId: orgId, userId: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ── Groups ─────────────────────────────────────────────────────────────────

scimRoutes.get('/Groups', authenticateScim, requireScimScope('groups:read'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const displayName = eqFilter(req as ScimRequest, 'displayName');
    const { startIndex, count } = pagination(req as ScimRequest);
    const where = { organizationId: orgId, ...(displayName ? { displayName } : {}) };
    const [total, rows] = await Promise.all([
      prisma.scimGroup.count({ where }),
      prisma.scimGroup.findMany({ where, orderBy: { createdAt: 'asc' }, skip: startIndex - 1, take: count }),
    ]);
    listResponse(res, total, rows.map(toScimGroup), startIndex);
  } catch (error) {
    next(error);
  }
});

scimRoutes.get('/Groups/:id', authenticateScim, requireScimScope('groups:read'), async (req, res, next) => {
  try {
    const g = await prisma.scimGroup.findFirst({
      where: { id: req.params.id, organizationId: orgOf(req as ScimRequest) },
    });
    if (!g) throw new ScimError(404, 'Group not found');
    res.status(200).json(toScimGroup(g));
  } catch (error) {
    next(error);
  }
});

/** Member ids from a SCIM `members: [{value}]` array, deduped. */
function memberIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((m) => (m && typeof m === 'object' ? (m as { value?: unknown }).value : m)).filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

scimRoutes.post('/Groups', authenticateScim, requireScimScope('groups:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) throw new ScimError(400, 'displayName is required');
    const created = await prisma.scimGroup.create({
      data: {
        organizationId: orgId,
        displayName,
        externalId: typeof body.externalId === 'string' ? body.externalId : null,
        members: memberIds(body.members),
      },
    }).catch((e: { code?: string }) => {
      if (e?.code === 'P2002') throw new ScimError(409, 'A group with that displayName already exists');
      throw e;
    });
    logger.info('scim: group created', { source: 'scim', organizationId: orgId, groupId: created.id });
    res.status(201).json(toScimGroup(created));
  } catch (error) {
    next(error);
  }
});

scimRoutes.put('/Groups/:id', authenticateScim, requireScimScope('groups:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const existing = await prisma.scimGroup.findFirst({ where: { id: req.params.id, organizationId: orgId } });
    if (!existing) throw new ScimError(404, 'Group not found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await prisma.scimGroup.update({
      where: { id: existing.id },
      data: {
        ...(typeof body.displayName === 'string' && body.displayName.trim() ? { displayName: body.displayName.trim() } : {}),
        ...(typeof body.externalId === 'string' || body.externalId === null
          ? { externalId: (body.externalId as string | null) ?? null }
          : {}),
        ...(body.members !== undefined ? { members: memberIds(body.members) } : {}),
      },
    });
    res.status(200).json(toScimGroup(updated));
  } catch (error) {
    next(error);
  }
});

scimRoutes.patch('/Groups/:id', authenticateScim, requireScimScope('groups:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const g = await prisma.scimGroup.findFirst({ where: { id: req.params.id, organizationId: orgId } });
    if (!g) throw new ScimError(404, 'Group not found');
    const body = (req.body ?? {}) as { Operations?: Operation[]; operations?: Operation[] };
    const operations = body.Operations ?? body.operations ?? [];
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ScimError(400, 'A PATCH must carry at least one operation');
    }
    let members = [...g.members];
    let displayName = g.displayName;
    for (const op of operations) {
      const name = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '').toLowerCase();
      if (path === 'displayname' && typeof op.value === 'string') {
        displayName = op.value.trim() || displayName;
        continue;
      }
      if (path === 'members') {
        const ids = memberIds(op.value);
        if (name === 'add') members = [...new Set([...members, ...ids])];
        else if (name === 'remove') {
          // RFC 7644 §3.5.2.2 allows a value-less remove with a `path` filter
          // (`members[value eq "id"]`) — accept that shape too.
          const filtered = /members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(String(op.path ?? ''));
          members = filtered ? members.filter((m) => m !== filtered[1]) : members.filter((m) => !ids.includes(m));
        } else members = ids;
        continue;
      }
      if (path === '' && name === 'replace' && op.value && typeof op.value === 'object') {
        const v = op.value as Record<string, unknown>;
        if (typeof v.displayName === 'string') displayName = v.displayName.trim() || displayName;
        if (Array.isArray(v.members)) members = memberIds(v.members);
        continue;
      }
      throw new ScimError(400, `Unsupported PATCH path "${op.path ?? ''}"`);
    }
    const updated = await prisma.scimGroup.update({
      where: { id: g.id },
      data: { members, displayName },
    });
    res.status(200).json(toScimGroup(updated));
  } catch (error) {
    next(error);
  }
});

scimRoutes.delete('/Groups/:id', authenticateScim, requireScimScope('groups:write'), async (req, res, next) => {
  try {
    const orgId = orgOf(req as ScimRequest);
    const g = await prisma.scimGroup.findFirst({ where: { id: req.params.id, organizationId: orgId } });
    if (!g) throw new ScimError(404, 'Group not found');
    // A group IS provisioning metadata, so deleting it destroys nothing a person
    // owns — unlike a User, where the same verb means deprovision (see above).
    await prisma.scimGroup.delete({ where: { id: g.id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** Central error shape: SCIM clients parse the RFC body, not `{ error }`. */
scimRoutes.use((error: unknown, _req: ScimRequest, res: Response, next: (e?: unknown) => void) => {
  if (error instanceof ScimError) {
    scimError(res, error.statusCode, error.message);
    return;
  }
  next(error);
});

export type { ScimScope };