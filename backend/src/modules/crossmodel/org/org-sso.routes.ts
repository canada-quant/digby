/**
 * PER-ORG SSO ADMIN SURFACE (Phase 3 Enterprise SSO/SAML, todo 3ad2b010).
 *
 * The tenant-facing counterpart of the OPEN login router
 * (`org-sso-open.routes.ts`). This file is mounted AFTER the app-level
 * `authenticate` guard, so every caller here is signed in — but signed-in says
 * nothing about WHICH org they may reconfigure. That question is answered per
 * request by `requireOrgCapability(userId, :orgId, 'sso:manage')`, which is
 * OWNER-only.
 *
 * WHY OWNER-ONLY AND NOT `org:update` (which ADMIN holds): the IdP config
 * decides who may authenticate INTO the tenant at all. An ADMIN who could
 * repoint the org at an IdP they control, and widen `allowedEmailDomains`,
 * could mint accounts for outsiders. Widening the membership boundary of a
 * tenant is an ownership act.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *  - No route returns a stored secret. `oidcClientSecret` is write-only: the
 *    read shape carries `hasClientSecret: boolean`. A tenant admin can replace
 *    it, never read it back — so a compromised session cannot exfiltrate the
 *    secret and impersonate the tenant at its own IdP.
 *  - No route ENABLES federation as a side effect of saving config. `enabled` is
 *    its own explicit field, so a half-finished config is inert.
 *  - No route lets `jitRole` be OWNER/ADMIN. Provisioning that mints privilege
 *    would turn "configure the IdP" into "mint an owner".
 */
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AuthRequest } from '../../../middleware/auth';
import { AppError } from '../../../middleware/app-error';
import { validate } from '../../../middleware/validate';
import { requireOrgCapability } from './org-access';
import {
  JIT_ASSIGNABLE_ROLES,
  isJitAssignableRole,
  normalizeEmailDomains,
  sealClientSecret,
} from './org-sso.service';

export const orgSsoRoutes = Router();

/**
 * The ONLY shape a read path may return.
 *
 * Note what is missing: `oidcClientSecret`. Explicit `select` (rather than
 * omitting a field from a full row) is what keeps a future column from leaking
 * by default — a new secret column is invisible here until someone adds it.
 */
const PROVIDER_READ_SELECT = {
  id: true,
  organizationId: true,
  protocol: true,
  enabled: true,
  displayName: true,
  oidcIssuer: true,
  oidcClientId: true,
  samlEntryPoint: true,
  samlIssuer: true,
  allowedEmailDomains: true,
  jitEnabled: true,
  jitRole: true,
  createdAt: true,
  updatedAt: true,
} as const;

const protocolSchema = z.object({
  params: z.object({ orgId: z.string().uuid() }),
});

const upsertSchema = z.object({
  params: z.object({ orgId: z.string().uuid() }),
  body: z
    .object({
      protocol: z.enum(['OIDC', 'SAML']),
      enabled: z.boolean().optional(),
      displayName: z.string().max(120).nullish(),
      // ── OIDC ──
      oidcIssuer: z.string().url().nullish(),
      oidcClientId: z.string().max(512).nullish(),
      /** Write-only. Absent/undefined leaves the stored secret untouched. */
      oidcClientSecret: z.string().min(1).max(2048).nullish(),
      // ── SAML ──
      samlEntryPoint: z.string().url().nullish(),
      samlIssuer: z.string().max(512).nullish(),
      samlIdpCert: z.string().max(20000).nullish(),
      // ── JIT ──
      allowedEmailDomains: z.array(z.string()).max(50).optional(),
      jitEnabled: z.boolean().optional(),
      /** Rejected unless MEMBER|BILLING — see the header and the service. */
      jitRole: z.string().optional(),
    })
    .refine((v) => v.protocol !== 'OIDC' || (v.oidcIssuer && v.oidcClientId) || true, {
      // Deliberately permissive at save time: a config may be staged in two
      // steps. `assertProviderUsable` refuses to SERVE an incomplete config, and
      // `enabled` is explicit, so a half-saved IdP is inert rather than live.
      message: 'incomplete',
    }),
});

/** GET /orgs/:orgId/sso — the tenant's IdP config, secrets redacted. */
orgSsoRoutes.get('/orgs/:orgId/sso', validate(protocolSchema), async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const { orgId } = req.params;
    await requireOrgCapability(userId, orgId, 'sso:manage');

    const provider = await prisma.orgIdentityProvider.findUnique({
      where: { organizationId: orgId },
      select: { ...PROVIDER_READ_SELECT, oidcClientSecret: true },
    });

    if (!provider) {
      // No provider is a legitimate "unconfigured" state, not an error — but the
      // capability check already ran, so this reveals nothing to a non-owner.
      return res.json({ provider: null, hasClientSecret: false });
    }

    const { oidcClientSecret, ...rest } = provider;
    res.json({ provider: rest, hasClientSecret: !!oidcClientSecret });
  } catch (err) {
    next(err);
  }
});

/** PUT /orgs/:orgId/sso — create or update the tenant's IdP. OWNER only. */
orgSsoRoutes.put('/orgs/:orgId/sso', validate(upsertSchema), async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const { orgId } = req.params;
    await requireOrgCapability(userId, orgId, 'sso:manage');

    const body = req.body as z.infer<typeof upsertSchema>['body'];

    // ── JIT role clamp, on WRITE ────────────────────────────────────────────
    // Refused loudly rather than silently coerced: an operator who asked for
    // OWNER provisioning must be told that does not exist, not handed MEMBER and
    // left believing the tenant will mint owners.
    if (body.jitRole !== undefined && !isJitAssignableRole(body.jitRole)) {
      throw new AppError(
        400,
        `jitRole must be one of ${JIT_ASSIGNABLE_ROLES.join(', ')} — provisioning may never grant a senior role`,
      );
    }

    const domains =
      body.allowedEmailDomains === undefined ? undefined : normalizeEmailDomains(body.allowedEmailDomains);

    // Only encrypt when a NEW secret is supplied; an omitted field must leave the
    // stored ciphertext intact (otherwise every unrelated edit would blank it).
    const secret =
      body.oidcClientSecret === undefined || body.oidcClientSecret === null
        ? undefined
        : sealClientSecret(body.oidcClientSecret);

    const data = {
      protocol: body.protocol,
      enabled: body.enabled ?? false,
      displayName: body.displayName ?? null,
      oidcIssuer: body.oidcIssuer ?? null,
      oidcClientId: body.oidcClientId ?? null,
      samlEntryPoint: body.samlEntryPoint ?? null,
      samlIssuer: body.samlIssuer ?? null,
      samlIdpCert: body.samlIdpCert ?? null,
      ...(domains === undefined ? {} : { allowedEmailDomains: domains }),
      jitEnabled: body.jitEnabled ?? true,
      ...(body.jitRole === undefined ? {} : { jitRole: body.jitRole as 'MEMBER' | 'BILLING' }),
      ...(secret === undefined ? {} : { oidcClientSecret: secret }),
    };

    const provider = await prisma.orgIdentityProvider.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, ...data },
      update: data,
      select: { ...PROVIDER_READ_SELECT, oidcClientSecret: true },
    });

    logger.info('sso: identity provider configured', {
      source: 'org-sso',
      organizationId: orgId,
      protocol: provider.protocol,
      enabled: provider.enabled,
      actorId: userId,
    });

    const { oidcClientSecret, ...rest } = provider;
    res.json({ provider: rest, hasClientSecret: !!oidcClientSecret });
  } catch (err) {
    next(err);
  }
});

/** DELETE /orgs/:orgId/sso — remove federation. OWNER only. */
orgSsoRoutes.delete('/orgs/:orgId/sso', validate(protocolSchema), async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const { orgId } = req.params;
    await requireOrgCapability(userId, orgId, 'sso:manage');

    // Cascades to federated_identities and any in-flight states (FK ON DELETE
    // CASCADE), so "removed" means every trace of the link is gone rather than
    // a provider row with dangling identities that could be re-enabled later.
    const deleted = await prisma.orgIdentityProvider.deleteMany({ where: { organizationId: orgId } });

    logger.info('sso: identity provider removed', {
      source: 'org-sso',
      organizationId: orgId,
      actorId: userId,
      removed: deleted.count,
    });

    res.json({ removed: deleted.count });
  } catch (err) {
    next(err);
  }
});