/**
 * PER-ORG SSO LOGIN SURFACE — the OPEN half of federation (todo 3ad2b010).
 *
 * WHY THESE ROUTES ARE OPEN: a federated user is BY DEFINITION not signed in
 * yet. Mounting them behind the app-level `authenticate` guard would make the
 * only entry point to federation unreachable. They therefore live in a router
 * mounted BEFORE the guard (see app.ts), like `crossmodel-open.routes.ts`, and
 * must never call `router.use(authenticate)` — route-posture.test.ts pins it.
 *
 * ── WHAT PROTECTS THEM INSTEAD OF A SESSION ────────────────────────────────
 *  1. `:orgId` is a UUID and the provider is only served when `enabled=true`.
 *     A tenant that never configured SSO answers 404, identical to an org id
 *     that does not exist — so this surface cannot be used to test whether an
 *     organization exists (the same 404-not-403 rule the member routes keep).
 *  2. Every callback must present a `state` this server issued, unexpired and
 *     unclaimed. `claimLoginState` is a single conditional UPDATE, so a captured
 *     callback URL is not replayable.
 *  3. The assertion is validated by the protocol library (node-saml verifies the
 *     XML signature; openid-client verifies the ID token against the issuer's
 *     JWKS). Nothing here parses trust-bearing XML or JWT by hand.
 *  4. `returnTo` is accepted only as a same-origin absolute path (`safeReturnTo`),
 *     re-checked at USE, so this cannot become an open redirect.
 *
 * ── WHAT THESE ROUTES DELIBERATELY DO NOT DO ───────────────────────────────
 *  - They do not reveal WHY a login failed beyond a generic message. "No such
 *    user" vs "domain not allowed" vs "not a member" would each tell an
 *    unauthenticated caller something about the tenant's people.
 *  - They do not create a session for an account that merely shares an email
 *    with an assertion. Only a prior `federated_identities` link (or a
 *    JIT-created account) can produce a session — see the service header.
 */
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import { validate } from '../../../middleware/validate';
import { generateAccessToken, generateRefreshToken } from '../../../utils/jwt';
import {
  beginOidcLogin,
  beginSamlLogin,
  claimLoginState,
  completeOidcLogin,
  completeSamlLogin,
  resolveOrProvisionUser,
  safeReturnTo,
  samlAcsUrl,
  type ProviderConfig,
} from './org-sso.service';

export const orgSsoOpenRoutes = Router();

/** Columns the login path needs. Never the secret — that is read only at exchange. */
const LOGIN_SELECT = {
  id: true,
  organizationId: true,
  protocol: true,
  enabled: true,
  oidcIssuer: true,
  oidcClientId: true,
  samlEntryPoint: true,
  samlIssuer: true,
  samlIdpCert: true,
  allowedEmailDomains: true,
  jitEnabled: true,
  jitRole: true,
} as const;

const orgParam = z.object({ params: z.object({ orgId: z.string().uuid() }) });

const startSchema = z.object({
  params: z.object({ orgId: z.string().uuid() }),
  query: z.object({ returnTo: z.string().max(2048).optional() }).optional(),
});

/**
 * Load an ENABLED provider for an org, or throw the same 404 a stranger gets.
 *
 * The 404-not-403 posture applies to unauthenticated callers too: an org with no
 * SSO and an org that does not exist must be indistinguishable.
 */
async function loadEnabledProvider(orgId: string): Promise<ProviderConfig> {
  const provider = await prisma.orgIdentityProvider.findUnique({
    where: { organizationId: orgId },
    select: LOGIN_SELECT,
  });
  if (!provider || !provider.enabled) {
    throw new AppError(404, 'Single sign-on is not configured for this workspace');
  }
  return provider as ProviderConfig;
}

/**
 * GET /orgs/:orgId/sso/start — redirect the browser to the tenant's IdP.
 *
 * Returns the URL as JSON rather than a 302 so the SPA can decide how to
 * navigate (and can show its own error surface when this 404s). A redirect here
 * would make a refused login look like a broken page.
 */
orgSsoOpenRoutes.get('/orgs/:orgId/sso/start', validate(startSchema), async (req, res, next) => {
  try {
    const { orgId } = req.params;
    const returnTo = safeReturnTo((req.query as { returnTo?: string }).returnTo);
    const provider = await loadEnabledProvider(orgId);

    if (provider.protocol === 'OIDC') {
      const { url, state } = await beginOidcLogin(provider, returnTo);
      return res.json({ url, state, protocol: 'OIDC' });
    }

    const { url, requestId } = await beginSamlLogin(provider, returnTo);
    res.json({ url, state: `saml:${requestId}`, protocol: 'SAML' });
  } catch (err) {
    next(err);
  }
});

/**
 * Issue a Digby session for a resolved federated identity.
 *
 * Mirrors the password login's token shape exactly (same generators, same
 * refresh-token persistence) so a federated session is NOT a second-class
 * session: every downstream guard sees an ordinary token.
 */
async function issueSession(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new AppError(401, 'Account not found');

  const accessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken({ userId: user.id, email: user.email, role: user.role });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken, refreshToken };
}

/** GET /orgs/sso/callback — OIDC authorization-code return. */
orgSsoOpenRoutes.get('/orgs/sso/callback', async (req, res, next) => {
  try {
    const query = req.query as Record<string, string | undefined>;
    const state = query.state;
    if (!state) throw new AppError(400, 'This sign-in link is no longer valid — start again');

    // Claim BEFORE exchanging: a replayed callback must not reach the IdP.
    const stateRow = await claimLoginState(state);
    if (!stateRow) throw new AppError(400, 'This sign-in link is no longer valid — start again');

    const provider = await loadEnabledProvider(stateRow.organizationId);
    if (provider.protocol !== 'OIDC') {
      throw new AppError(400, 'This workspace is not configured for OpenID Connect');
    }
    if (!stateRow.codeVerifier) {
      throw new AppError(400, 'This sign-in link is no longer valid — start again');
    }

    // Rebuild the URL the IdP called us on: openid-client validates the callback
    // parameters AND that redirect_uri matches what we registered.
    const base =
      process.env.API_PUBLIC_BASE_URL ||
      process.env.SSO_PUBLIC_BASE_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000';
    const currentUrl = new URL('/api/crossmodel/orgs/sso/callback', base.replace(/\/+$/, ''));
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) currentUrl.searchParams.set(key, value);
    }

    const identity = await completeOidcLogin({
      provider,
      currentUrl,
      state,
      expectedNonce: stateRow.nonce,
      codeVerifier: stateRow.codeVerifier,
    });

    const resolved = await resolveOrProvisionUser({ provider, ...identity });
    const session = await issueSession(resolved.userId);

    logger.info('sso: OIDC login succeeded', {
      source: 'org-sso',
      organizationId: provider.organizationId,
      userId: resolved.userId,
      created: resolved.created,
    });

    res.json({
      ...session,
      created: resolved.created,
      returnTo: safeReturnTo(stateRow.returnTo),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /orgs/sso/acs — SAML Assertion Consumer Service. */
orgSsoOpenRoutes.post('/orgs/sso/acs', async (req, res, next) => {
  try {
    const body = req.body as { SAMLResponse?: string; RelayState?: string };
    const samlResponse = body?.SAMLResponse;
    if (!samlResponse) throw new AppError(400, 'This sign-in link is no longer valid — start again');

    // RelayState carries the opaque `saml:<requestId>` state we issued.
    const relay = body?.RelayState;
    if (!relay) throw new AppError(400, 'This sign-in link is no longer valid — start again');

    const stateRow = await claimLoginState(relay);
    if (!stateRow) throw new AppError(400, 'This sign-in link is no longer valid — start again');

    const provider = await loadEnabledProvider(stateRow.organizationId);
    if (provider.protocol !== 'SAML') {
      throw new AppError(400, 'This workspace is not configured for SAML');
    }

    const identity = await completeSamlLogin({
      provider,
      samlResponse,
      expectedRequestId: stateRow.requestId,
    });

    const resolved = await resolveOrProvisionUser({ provider, ...identity });
    const session = await issueSession(resolved.userId);

    logger.info('sso: SAML login succeeded', {
      source: 'org-sso',
      organizationId: provider.organizationId,
      userId: resolved.userId,
      created: resolved.created,
    });

    res.json({
      ...session,
      created: resolved.created,
      returnTo: safeReturnTo(stateRow.returnTo),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /orgs/:orgId/sso/metadata — SP metadata a SAML tenant registers at its IdP. */
orgSsoOpenRoutes.get('/orgs/:orgId/sso/metadata', validate(orgParam), async (req, res, next) => {
  try {
    const provider = await loadEnabledProvider(req.params.orgId);
    if (provider.protocol !== 'SAML') {
      throw new AppError(404, 'This workspace is not configured for SAML');
    }
    res.json({
      acsUrl: samlAcsUrl(),
      // The entity id the customer must register; it is whatever they configured
      // as `samlIssuer`, echoed back so the two sides can be compared by eye.
      entityId: provider.samlIssuer,
      protocol: 'SAML',
    });
  } catch (err) {
    next(err);
  }
});