/**
 * PER-ORG IDENTITY FEDERATION — OIDC + SAML 2.0 (Phase 3 Enterprise, todo 3ad2b010).
 *
 * WHAT THIS OWNS: turning an assertion from a tenant's IdP into a Digby user
 * session, and nothing else. It does not decide WHO may configure an IdP (that
 * is `sso:manage` in org-access.ts) and it does not issue HTTP responses (that
 * is org-sso.routes.ts). Everything security-relevant about federation is here,
 * in ONE file, so the invariants below can be read in one sitting.
 *
 * ── INVARIANT 1: A LOGIN IS RESOLVED BY (provider, subject) — NEVER BY EMAIL. ──
 * The lookup key is `federated_identities.(providerId, subject)`. We never say
 * "the IdP asserted victim@corp.com, so log in as the user with that address".
 * If we did, anyone who can make an IdP assert an address they do not own —
 * a misconfigured tenant IdP, a compromised one, or an admin of a DIFFERENT
 * tenant who registers the victim's domain — signs in as that existing user.
 * On a tenant whose OWNER also uses SSO that is takeover of the tenant.
 *
 * A consequence worth stating plainly: changing your email at the IdP does NOT
 * move your Digby account, and an account created by password signup is NEVER
 * silently adopted by a later SSO login. Adoption needs an explicit, already-
 * authenticated linking step (out of scope here) precisely because the
 * email-matching shortcut is the vulnerability.
 *
 * ── INVARIANT 2: JIT CANNOT MINT PRIVILEGE. ──
 * A JIT-created member gets `adaptiveJitRole(...)`, which clamps to
 * MEMBER or BILLING. It can never be OWNER or ADMIN, whatever `jitRole` holds.
 * The reason is concrete: an ADMIN holds `org:update` but NOT `sso:manage`; if a
 * JIT role could be OWNER, then the OWNER-only gate on configuring the IdP would
 * be the only thing between an ADMIN and tenant ownership — one stolen OWNER
 * click instead of two independent powers. Clamping is applied on READ as well
 * as write, so a row written by an older/other build cannot escalate.
 *
 * ── INVARIANT 3: JIT IS CLOSED UNLESS A DOMAIN IS ALLOWED. ──
 * `allowedEmailDomains` empty ⇒ no JIT. It never means "any domain": an open JIT
 * on a live IdP lets anyone that IdP authenticates mint an account in this
 * tenant. Existing links keep working when the list is emptied — turning off
 * provisioning must not lock out the people already inside.
 *
 * ── INVARIANT 4: EVERY LOGIN STATE IS SINGLE USE. ──
 * `sso_login_states` rows are claimed with ONE conditional UPDATE
 * (`consumedAt IS NULL AND expiresAt > now`) inside a transaction with the
 * identity resolution. A captured callback URL is therefore not replayable —
 * read-then-write would leave a window where two concurrent callbacks both pass
 * the check, which is a session-fixation primitive.
 *
 * ── INVARIANT 5: THIS MODULE DOES NOT TRUST ITS CALLER'S CONFIG BLIND. ──
 * `assertProviderUsable` fails closed on a disabled provider, a protocol/config
 * mismatch, or a missing secret. A half-saved IdP is inert rather than
 * accidentally permissive.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { SAML } from '@node-saml/node-saml';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';
import { encryptWith, decryptWith } from '../google/crypto';
import { normalizeOrgRole, type OrgRoleName } from './org-access';

/**
 * `openid-client` v6 ships as ESM-ONLY (`"type": "module"`), so it cannot be
 * `require`d by this CommonJS build or by jest's runtime — a static import here
 * would break EVERY suite that transitively imports this file, not just the SSO
 * ones. Loading it lazily keeps the OIDC dependency off the module graph until a
 * tenant actually uses OIDC, and lets the SAML/CRUD paths (and their tests) run
 * without it.
 *
 * Typed structurally rather than by importing its types at module scope: a
 * `import type` is erased at build time, so it stays safe, and this shape names
 * exactly the five functions used below.
 */
interface OpenIdClientModule {
  discovery: (server: URL, clientId: string, clientSecret?: string) => Promise<unknown>;
  buildAuthorizationUrl: (config: unknown, params: Record<string, string>) => URL;
  authorizationCodeGrant: (
    config: unknown,
    currentUrl: URL,
    checks: {
      pkceCodeVerifier: string;
      expectedState?: string;
      expectedNonce?: string;
      idTokenExpected?: boolean;
    },
  ) => Promise<{ claims: () => Record<string, unknown> | undefined }>;
  calculatePKCECodeChallenge: (verifier: string) => Promise<string>;
  randomPKCECodeVerifier: () => string;
  randomState: () => string;
  randomNonce: () => string;
}

let openIdClientPromise: Promise<OpenIdClientModule> | null = null;

/**
 * Load `openid-client` once, on first use.
 *
 * The `await import()` is transparent to both tsc (module: commonjs) and jest,
 * because it happens at CALL time rather than module-evaluation time.
 */
async function openIdClient(): Promise<OpenIdClientModule> {
  if (!openIdClientPromise) {
    openIdClientPromise = (import('openid-client') as unknown as Promise<OpenIdClientModule>).catch((err) => {
      // Reset so a transient failure can be retried rather than poisoning the
      // process for every later login.
      openIdClientPromise = null;
      throw err;
    });
  }
  return openIdClientPromise;
}

/** An opaque, URL-safe random string (state/nonce) without touching the ESM lib. */
function randomOpaque(): string {
  return randomBytes(32).toString('base64url');
}

/** An RFC 7636 PKCE code verifier: 43-128 chars from the unreserved set. */
function randomCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** The env var holding the AES-256-GCM key for IdP client secrets. */
export const SSO_ENCRYPTION_KEY_ENV = 'ORG_SSO_ENCRYPTION_KEY';

/** How long an in-flight federated login may stay unclaimed. */
export const SSO_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The roles a JIT-provisioned member may hold. Deliberately excludes OWNER and
 * ADMIN — see INVARIANT 2 in the file header.
 */
export const JIT_ASSIGNABLE_ROLES = ['MEMBER', 'BILLING'] as const;
export type JitAssignableRole = (typeof JIT_ASSIGNABLE_ROLES)[number];

/**
 * Clamp a stored/requested JIT role to what provisioning may actually grant.
 *
 * Applied on WRITE (reject an out-of-range value with 400) and on READ (coerce
 * silently), so a row that somehow holds OWNER cannot mint one. Returns MEMBER
 * for anything unrecognised, because failing closed means "least privilege",
 * not "throw on the login path".
 */
export function adaptiveJitRole(role: string | null | undefined): JitAssignableRole {
  const normalized = normalizeOrgRole(role);
  if (normalized === 'BILLING') return 'BILLING';
  return 'MEMBER';
}

/** True when `role` is a value provisioning is allowed to store at all. */
export function isJitAssignableRole(role: string | null | undefined): role is JitAssignableRole {
  const normalized = normalizeOrgRole(role);
  return normalized === 'MEMBER' || normalized === 'BILLING';
}

/**
 * Normalize and validate an operator-supplied domain allowlist.
 *
 * Accepts `corp.com` / `@corp.com` / `CORP.com` and stores bare lowercase
 * domains. Rejects anything with a scheme, a path, a wildcard, or an inner dot
 * pattern we cannot reason about — a permissive parser here is how an allowlist
 * quietly becomes "match anything".
 */
export function normalizeEmailDomains(domains: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const value = String(raw ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!value) continue;
    // Bare registrable-ish domain only: labels of [a-z0-9-], no scheme/path/space.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
      throw new AppError(400, `Not a bare email domain: ${raw}`);
    }
    out.add(value);
  }
  return [...out];
}

/** The domain part of an email, lowercase, or '' when there is none. */
export function emailDomain(email: string): string {
  const at = String(email ?? '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).trim().toLowerCase();
}

/**
 * May JIT create an account for this address in this tenant?
 *
 * Two independent conditions, both required: provisioning is enabled, and the
 * address's domain is explicitly allowed. An empty allowlist is CLOSED.
 */
export function jitAllows(
  provider: { jitEnabled: boolean; allowedEmailDomains: readonly string[] | null | undefined },
  email: string,
): boolean {
  if (!provider.jitEnabled) return false;
  const allowed = provider.allowedEmailDomains ?? [];
  if (allowed.length === 0) return false;
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowed.some((entry) => String(entry).trim().toLowerCase() === domain);
}

/**
 * A `returnTo` value that is safe to redirect to, or null.
 *
 * Only same-origin ABSOLUTE PATHS survive ("/chats/abc"). Rejecting protocol-
 * relative "//evil.com" matters: browsers treat it as an absolute URL to another
 * host, so allowing it turns our own login redirect into an open redirect that
 * lends this domain's credibility to an attacker's page.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = String(value).trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  // Backslashes are normalised to slashes by several browsers — reject outright.
  if (candidate.includes('\\')) return null;
  return candidate;
}

/** The row shape this service needs. Never includes the sealed secret. */
export interface ProviderConfig {
  id: string;
  organizationId: string;
  protocol: 'OIDC' | 'SAML';
  enabled: boolean;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  samlEntryPoint: string | null;
  samlIssuer: string | null;
  samlIdpCert: string | null;
  allowedEmailDomains: string[];
  jitEnabled: boolean;
  jitRole: string;
}

/**
 * Fail closed unless the provider is fully configured for its protocol.
 *
 * Called at the TOP of every login entry point, so "saved but not enabled" and
 * "enabled but incomplete" are both refused before any network call or state row.
 */
export function assertProviderUsable(provider: ProviderConfig): void {
  if (!provider.enabled) throw new AppError(404, 'Single sign-on is not enabled for this workspace');
  if (provider.protocol === 'OIDC') {
    if (!provider.oidcIssuer || !provider.oidcClientId) {
      throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
    }
  } else if (provider.protocol === 'SAML') {
    if (!provider.samlEntryPoint || !provider.samlIssuer || !provider.samlIdpCert) {
      throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
    }
  } else {
    throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
  }
}

// ── Secrets at rest ─────────────────────────────────────────────────────────

/** Encrypt a client secret for storage. Throws EncryptionKeyError when unkeyed. */
export function sealClientSecret(plaintext: string): string {
  return encryptWith(plaintext, SSO_ENCRYPTION_KEY_ENV);
}

/** Decrypt a stored client secret. Only the OIDC callback path needs this. */
export function openClientSecret(ciphertext: string): string {
  return decryptWith(ciphertext, SSO_ENCRYPTION_KEY_ENV);
}

// ── Login state ─────────────────────────────────────────────────────────────

/**
 * Persist an in-flight login and return the opaque `state`.
 *
 * The state is derived from random bytes and stored UNIQUE, so two concurrent
 * logins cannot share a verifier. `codeVerifier`/`nonce`/`requestId` are the
 * only things carried across the IdP redirect — never a user id, which is the
 * point: at issue time we do not yet know who the user is.
 */
export async function createLoginState(input: {
  organizationId: string;
  codeVerifier?: string | null;
  nonce?: string | null;
  requestId?: string | null;
  returnTo?: string | null;
}): Promise<string> {
  const state = randomOpaque();
  await prisma.ssoLoginState.create({
    data: {
      state,
      organizationId: input.organizationId,
      codeVerifier: input.codeVerifier ?? null,
      nonce: input.nonce ?? null,
      requestId: input.requestId ?? null,
      returnTo: safeReturnTo(input.returnTo),
      expiresAt: new Date(Date.now() + SSO_STATE_TTL_MS),
    },
  });
  return state;
}

/**
 * Claim a state row for ONE use, atomically.
 *
 * `updateMany` with the unconsumed/unexpired predicate compiles to a single
 * conditional UPDATE, so exactly one concurrent caller can observe count=1.
 * A read-then-write here would let two replays of the same callback both pass.
 */
export async function claimLoginState(state: string, organizationId?: string) {
  const now = new Date();
  const claimed = await prisma.ssoLoginState.updateMany({
    where: {
      state,
      ...(organizationId ? { organizationId } : {}),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) {
    // Same message for "never existed", "expired" and "already used": telling
    // them apart would let an attacker distinguish a stale capture from a
    // forged one, which is the only information this endpoint could leak.
    throw new AppError(400, 'This sign-in link is no longer valid — start again');
  }
  return prisma.ssoLoginState.findUnique({ where: { state } });
}

// ── Identity resolution + JIT ───────────────────────────────────────────────

/**
 * Resolve an assertion to a Digby user, provisioning one only when allowed.
 *
 * Returns the user id plus whether the account was created by this call, so the
 * route can log/announce it honestly instead of guessing.
 *
 * MUST be called with a CLAIMED state (see claimLoginState); it does not claim.
 */
export async function resolveOrProvisionUser(input: {
  provider: ProviderConfig;
  subject: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}): Promise<{ userId: string; created: boolean; role: string }> {
  const { provider } = input;
  const subject = String(input.subject ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!subject) throw new AppError(400, 'The identity provider did not identify the user');
  if (!email) throw new AppError(400, 'The identity provider did not supply an email address');

  // ── Path A: an existing link. THE ONLY path that may log in an existing user.
  const link = await prisma.federatedIdentity.findUnique({
    where: { providerId_subject: { providerId: provider.id, subject } },
    select: { userId: true, organizationId: true },
  });

  if (link) {
    if (link.organizationId !== provider.organizationId) {
      // A link that points at another tenant must never authenticate here. This
      // should be unreachable (providerId belongs to one org), so treat it as a
      // defect rather than a user error and refuse closed.
      logger.error('sso: federated identity org does not match its provider org', {
        source: 'org-sso',
        organizationId: provider.organizationId,
      });
      throw new AppError(403, 'This identity is not linked to this workspace');
    }
    // The membership is what actually authorizes anything inside the org. A user
    // whose membership was removed loses SSO access even though the link exists.
    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: link.userId, organizationId: provider.organizationId } },
      select: { role: true, deactivatedAt: true },
    });
    // A DEPROVISIONED member is refused at the federated door too (SCIM 2.0,
    // todo 76113a98). This is a SECOND, independent enforcement point on purpose:
    // resolveMembership already treats the membership as absent for every
    // capability check, but SSO resolves the membership itself here (it needs the
    // role to report, not a capability). Without this filter an IdP that still
    // authenticates the user would hand back a session for a deprovisioned
    // identity — the deprovision would hold everywhere EXCEPT the one door the
    // identity provider controls, which is precisely the door it arrives through.
    if (!membership || membership.deactivatedAt) {
      throw new AppError(403, 'You are not a member of this workspace');
    }
    await prisma.federatedIdentity.updateMany({
      where: { providerId: provider.id, subject },
      data: { lastLoginAt: new Date(), email },
    });
    return { userId: link.userId, created: false, role: String(membership.role) };
  }

  // ── At this point there is no link. JIT is the ONLY way forward. ──────────
  if (!jitAllows(provider, email)) {
    // Distinguish "provisioning off" from "your domain is not allowed" for the
    // OPERATOR log, but return ONE message to the caller: the second sentence
    // would confirm whether a given tenant allows a given domain.
    logger.warn('sso: JIT refused', {
      source: 'org-sso',
      organizationId: provider.organizationId,
      jitEnabled: provider.jitEnabled,
      allowedCount: (provider.allowedEmailDomains ?? []).length,
      domain: emailDomain(email),
    });
    throw new AppError(403, 'Your account is not provisioned for this workspace. Ask your administrator for access.');
  }

  const role = adaptiveJitRole(provider.jitRole);

  // A pre-existing Digby user with this address is NOT adopted (INVARIANT 1).
  // Provisioning would collide on the unique email, so say so plainly and let an
  // operator resolve it rather than creating a duplicate or silently taking over.
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    const existingLink = await prisma.federatedIdentity.findUnique({
      where: { userId_providerId: { userId: existingUser.id, providerId: provider.id } },
      select: { id: true },
    });
    if (existingLink) {
      throw new AppError(409, 'This account is already linked with a different identity — contact your administrator');
    }
    logger.warn('sso: JIT blocked, account already exists but is not linked', {
      source: 'org-sso',
      organizationId: provider.organizationId,
      userId: existingUser.id,
    });
    throw new AppError(
      409,
      'An account already exists for this address. Sign in with your existing method and link single sign-on from your account settings.',
    );
  }

  // Create the user, the membership and the link together: a user with no link
  // could never log in by SSO again, and a link with no user is a dangling FK.
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        // No usable password: this account exists only through its IdP. A random
        // 64-hex value is not a credential anyone holds, and the local login
        // path compares against it normally (so it simply never matches).
        password: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        // The IdP has already authenticated this address; asking the user to
        // click a link we mail them would be a downgrade, not a check.
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: provider.organizationId,
        role,
        // JIT never grants the DEFAULT org: isDefault drives which org a send
        // bills against, and a federated invitee joining a team must not have
        // their personal billing context silently repointed.
        isDefault: false,
      },
    });

    await tx.federatedIdentity.create({
      data: {
        userId: user.id,
        organizationId: provider.organizationId,
        providerId: provider.id,
        subject,
        email,
      },
    });

    return user.id;
  });

  logger.info('sso: JIT provisioned a member', {
    source: 'org-sso',
    organizationId: provider.organizationId,
    userId: created,
    role,
  });

  return { userId: created, created: true, role };
}

// ── OIDC ────────────────────────────────────────────────────────────────────

/** Where the IdP sends the browser back. Must be registered at the IdP. */
export function oidcRedirectUri(): string {
  const base = (process.env.SSO_PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000')
    .replace(/\/+$/, '');
  // The callback lives on the API host; the SPA route then finishes the session.
  const apiBase = (process.env.API_PUBLIC_BASE_URL || base).replace(/\/+$/, '');
  return `${apiBase}/api/crossmodel/orgs/sso/callback`;
}

/**
 * Build the authorization URL for an OIDC tenant and persist the state row.
 *
 * Discovery is fetched live from the tenant's issuer rather than cached: an
 * issuer URL is per-tenant configuration that can legitimately move (an IdP
 * migration), and a stale cache would send users to a retired endpoint with no
 * way for the operator to see why.
 */
export async function beginOidcLogin(
  provider: ProviderConfig,
  returnTo: string | null,
): Promise<{ url: string; state: string }> {
  assertProviderUsable(provider);
  if (!provider.oidcIssuer || !provider.oidcClientId) {
    throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
  }

  const oidc = await openIdClient();
  const server = await oidc.discovery(new URL(provider.oidcIssuer), provider.oidcClientId);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const nonce = oidc.randomNonce();
  const state = oidc.randomState();

  await prisma.ssoLoginState.create({
    data: {
      state,
      organizationId: provider.organizationId,
      codeVerifier,
      nonce,
      returnTo: safeReturnTo(returnTo),
      expiresAt: new Date(Date.now() + SSO_STATE_TTL_MS),
    },
  });

  const url = oidc.buildAuthorizationUrl(server, {
    redirect_uri: oidcRedirectUri(),
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: url.toString(), state };
}

/**
 * Complete an OIDC login: exchange the code, verify the ID token, resolve a user.
 *
 * `expectedState`/`expectedNonce` come from the CLAIMED state row (the caller
 * claims first). `authorizationCodeGrant` verifies the token signature against
 * the issuer's JWKS, the issuer, the audience, and the nonce — the library does
 * that work; this function does not re-implement JWT verification.
 */
export async function completeOidcLogin(input: {
  provider: ProviderConfig;
  currentUrl: URL;
  state: string;
  expectedNonce: string | null;
  /** The PKCE verifier from the CLAIMED state row. Required — without it the
   *  code exchange cannot prove this client started that authorization. */
  codeVerifier: string;
}): Promise<{ subject: string; email: string; firstName?: string | null; lastName?: string | null }> {
  if (!input.codeVerifier) {
    throw new AppError(400, 'This sign-in link is no longer valid — start again');
  }
  const { provider } = input;
  assertProviderUsable(provider);
  if (!provider.oidcIssuer || !provider.oidcClientId) {
    throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
  }

  const config = await prisma.orgIdentityProvider.findUnique({
    where: { id: provider.id },
    select: { oidcClientSecret: true },
  });
  if (!config?.oidcClientSecret) {
    throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
  }

  const clientSecret = openClientSecret(config.oidcClientSecret);
  const oidc = await openIdClient();
  const server = await oidc.discovery(new URL(provider.oidcIssuer), provider.oidcClientId, clientSecret);

  const tokens = await oidc.authorizationCodeGrant(server, input.currentUrl, {
    // From the CLAIMED state row: proves THIS client began this authorization.
    // Omitting it would leave an intercepted code redeemable by anyone.
    pkceCodeVerifier: input.codeVerifier,
    expectedState: input.state,
    expectedNonce: input.expectedNonce ?? undefined,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims?.sub) throw new AppError(400, 'The identity provider did not identify the user');
  const email = typeof claims.email === 'string' ? claims.email : '';
  if (!email) throw new AppError(400, 'The identity provider did not supply an email address');

  return {
    subject: String(claims.sub),
    email,
    firstName: typeof claims.given_name === 'string' ? claims.given_name : null,
    lastName: typeof claims.family_name === 'string' ? claims.family_name : null,
  };
}

// ── SAML 2.0 ────────────────────────────────────────────────────────────────

/** Build the SP-side SAML client for one tenant. */
function samlClientFor(provider: ProviderConfig): SAML {
  if (!provider.samlEntryPoint || !provider.samlIssuer || !provider.samlIdpCert) {
    throw new AppError(503, 'This workspace\'s SSO configuration is incomplete');
  }
  return new SAML({
    entryPoint: provider.samlEntryPoint,
    issuer: provider.samlIssuer,
    // The assertion is POSTed to us by the browser; node-saml validates the
    // XML signature against this certificate and rejects unsigned/wrapped
    // assertions. Hand-rolling this check is how signature-wrapping bugs ship.
    idpCert: provider.samlIdpCert,
    callbackUrl: samlAcsUrl(),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // We validate InResponseTo ourselves against the claimed state row, because
    // node-saml's cache provider would need shared storage across processes.
    validateInResponseTo: undefined,
  });
}

/** The Assertion Consumer Service URL. Must be registered at the IdP. */
export function samlAcsUrl(): string {
  const base = (process.env.SSO_PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000')
    .replace(/\/+$/, '');
  const apiBase = (process.env.API_PUBLIC_BASE_URL || base).replace(/\/+$/, '');
  return `${apiBase}/api/crossmodel/orgs/sso/acs`;
}

/** Build the AuthnRequest redirect URL for a SAML tenant and persist its id. */
export async function beginSamlLogin(
  provider: ProviderConfig,
  returnTo: string | null,
): Promise<{ url: string; requestId: string }> {
  assertProviderUsable(provider);
  const client = samlClientFor(provider);
  const requestId = `_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`;

  const url = await client.getAuthorizeUrlAsync('', undefined, {});
  const state = `saml:${requestId}`;
  await prisma.ssoLoginState.create({
    data: {
      state,
      organizationId: provider.organizationId,
      requestId,
      returnTo: safeReturnTo(returnTo),
      expiresAt: new Date(Date.now() + SSO_STATE_TTL_MS),
    },
  });
  return { url, requestId };
}

/**
 * Validate a SAML response and extract the identity.
 *
 * `expectedRequestId` comes from the claimed state row, so a response that
 * answers a DIFFERENT AuthnRequest (an unsolicited or replayed assertion) is
 * refused here even though its signature is valid.
 */
export async function completeSamlLogin(input: {
  provider: ProviderConfig;
  samlResponse: string;
  expectedRequestId: string | null;
}): Promise<{ subject: string; email: string }> {
  assertProviderUsable(input.provider);
  if (!input.expectedRequestId) {
    throw new AppError(400, 'This sign-in link is no longer valid — start again');
  }
  const client = samlClientFor(input.provider);

  const result = await client.validatePostResponseAsync({ SAMLResponse: input.samlResponse });
  const profile = result?.profile as Record<string, unknown> | undefined;
  if (!profile) throw new AppError(400, 'The identity provider returned no assertion');

  // InResponseTo binding: the assertion must answer the request WE issued.
  const inResponseTo = String((result as Record<string, unknown> | undefined)?.inResponseTo ?? '');
  if (inResponseTo !== input.expectedRequestId) {
    throw new AppError(400, 'This sign-in link is no longer valid — start again');
  }

  const nameId = String((profile.nameID as string) ?? '').trim();
  const email = String((profile.email as string) ?? (profile.mail as string) ?? '').trim();
  if (!nameId) throw new AppError(400, 'The identity provider did not identify the user');
  if (!email) throw new AppError(400, 'The identity provider did not supply an email address');

  return { subject: nameId, email };
}