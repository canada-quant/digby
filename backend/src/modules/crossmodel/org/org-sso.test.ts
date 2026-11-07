/**
 * PER-ORG SSO tests (Phase 3 Enterprise SSO/SAML, todo 3ad2b010).
 *
 * The point of this feature is a TRUST BOUNDARY, so that is what these pin. Three
 * properties, each of which is a real attack if it regresses:
 *
 *  1. CROSS-ORG ISOLATION IS 404, NOT 403 — on read AND write. The IdP config
 *     decides who may authenticate into a tenant, so an org-A admin who can read
 *     org-B's issuer has learned which IdP to phish; one who can WRITE it can
 *     point B at an IdP they control. Both answers must be identical to an org id
 *     that never existed. Asserted on status AND on "no org data in the body",
 *     plus "the mutation was never called" on every write.
 *
 *  2. JIT CANNOT MINT PRIVILEGE. `jitRole` is rejected at WRITE for anything but
 *     MEMBER/BILLING, and `adaptiveJitRole` clamps at READ so a row that somehow
 *     holds OWNER still provisions a MEMBER. The test that matters most is
 *     "a stored jitRole of OWNER provisions MEMBER" — that is the read-side clamp
 *     doing its job on a row this build would never have written.
 *
 *  3. A SESSION REQUIRES A PRIOR LINK. `resolveOrProvisionUser` never adopts an
 *     existing account by email; an unlinked existing address is refused (409)
 *     rather than silently taken over, and a login whose membership was removed
 *     is refused (403) even though its link row survives.
 *
 * Plus the smaller invariants that are easy to lose: secrets are never returned by
 * a read path, `returnTo` cannot become an open redirect, the domain allowlist is
 * closed when empty, and login state is single-use (a replayed callback fails).
 *
 * Hermetic, following the org-members.routes.test.ts idiom: the REAL routers, the
 * REAL `validate` middleware, the REAL `requireOrgCapability` predicate and the
 * REAL service functions run — prisma and logger are mocked, a bare express app
 * listens on port 0, and no app/env is booted. Mocking the code under test is the
 * review defect that file records, so it is not repeated here.
 *
 * ONE HONEST LIMITATION, inherited: this harness maps AppError → statusCode with a
 * local middleware instead of mounting the real errorHandler, because error-handler
 * imports config/env (which process.exit(1)s without env vars and kills the jest
 * worker). Every assertion is on the STATUS the real handler would emit.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    organization: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    refreshToken: { create: jest.fn() },
    orgIdentityProvider: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    federatedIdentity: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    ssoLoginState: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
/**
 * `utils/jwt` imports `config/env`, whose zod parse runs at MODULE LOAD and calls
 * process.exit(1) when the vars are absent — the normal condition in a hermetic
 * jest run. That would kill the worker before any test ran (the exact failure the
 * AppError leaf module was created to avoid). These two generators are the only
 * things the open router needs from it.
 */
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  generateAccessToken: jest.fn(() => 'test-access-token'),
  generateRefreshToken: jest.fn(() => 'test-refresh-token'),
}));

import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import { orgSsoRoutes } from './org-sso.routes';
import { orgSsoOpenRoutes } from './org-sso-open.routes';
import {
  adaptiveJitRole,
  emailDomain,
  isJitAssignableRole,
  jitAllows,
  normalizeEmailDomains,
  safeReturnTo,
  JIT_ASSIGNABLE_ROLES,
} from './org-sso.service';

const db = prisma as unknown as Record<string, any>;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_NEW = '33333333-3333-4333-8333-333333333333';

const ALICE = { id: 'u-alice', userId: 'u-alice', role: 'USER', email: 'alice@example.com' };

/** Stand-in for the app-level guard (these routes mount after `authenticate`). */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as any).user = JSON.parse(raw);
    next();
  });
  app.use(orgSsoRoutes);
  app.use(orgSsoOpenRoutes);
  app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Validation error' });
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    return res.status(500).json({ error: err?.message ?? 'error' });
  });
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const asUser = (u: object) => ({ 'content-type': 'application/json', 'x-test-user': JSON.stringify(u) });

/** Membership rows by (userId, orgId) — the ONE path org-access resolves. */
let memberships: Record<string, { organizationId: string; userId: string; role: string }>;
const key = (userId: string, orgId: string) => `${userId}::${orgId}`;

beforeEach(() => {
  jest.clearAllMocks();
  // Alice is OWNER of org A, and NOT a member of org B — the cross-tenant subject.
  memberships = {
    [key('u-alice', ORG_A)]: { organizationId: ORG_A, userId: 'u-alice', role: 'OWNER' },
  };
  db.membership.findUnique.mockImplementation(async ({ where }: any) => {
    const w = where.userId_organizationId;
    return memberships[key(w.userId, w.organizationId)] ?? null;
  });
  db.membership.findMany.mockResolvedValue([]);
  db.ssoLoginState.create.mockResolvedValue({});
  db.orgIdentityProvider.deleteMany.mockResolvedValue({ count: 0 });
});

// ── The capability: SSO config is OWNER-only ────────────────────────────────

describe('sso:manage capability', () => {
  it('is a real capability, held by OWNER and by no other role', async () => {
    const { roleCan, ORG_CAPABILITIES } = await import('./org-access');
    expect([...ORG_CAPABILITIES]).toContain('sso:manage');
    expect(roleCan('OWNER', 'sso:manage')).toBe(true);
    // The whole point: ADMIN holds org:update but MUST NOT be able to repoint a
    // tenant's IdP — that would let an admin widen the membership boundary.
    expect(roleCan('ADMIN', 'sso:manage')).toBe(false);
    expect(roleCan('BILLING', 'sso:manage')).toBe(false);
    expect(roleCan('MEMBER', 'sso:manage')).toBe(false);
  });
});

// ── HTTP: cross-org isolation on the admin surface ──────────────────────────

describe('GET /orgs/:orgId/sso — cross-org read is 404', () => {
  it('refuses a non-member with 404 and leaks no org data', async () => {
    const res = await fetch(`${base}/orgs/${ORG_B}/sso`, { headers: asUser(ALICE) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('oidc');
    expect(JSON.stringify(body)).not.toContain('saml');
    // The provider was never even read for a foreign org.
    expect(db.orgIdentityProvider.findUnique).not.toHaveBeenCalled();
  });

  it('answers identically for an org that does not exist (no existence oracle)', async () => {
    const foreign = await fetch(`${base}/orgs/${ORG_B}/sso`, { headers: asUser(ALICE) });
    const ghost = await fetch(`${base}/orgs/${ORG_NEW}/sso`, { headers: asUser(ALICE) });
    expect(foreign.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(await foreign.json()).toEqual(await ghost.json());
  });

  it('returns the provider to an OWNER with the secret REDACTED', async () => {
    db.orgIdentityProvider.findUnique.mockResolvedValue({
      id: 'prov-1',
      organizationId: ORG_A,
      protocol: 'OIDC',
      enabled: true,
      displayName: 'Okta',
      oidcIssuer: 'https://acme.okta.com',
      oidcClientId: 'client-123',
      oidcClientSecret: 'SEALED-CIPHERTEXT-MUST-NOT-APPEAR',
      samlEntryPoint: null,
      samlIssuer: null,
      allowedEmailDomains: ['acme.com'],
      jitEnabled: true,
      jitRole: 'MEMBER',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, { headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    // The ciphertext must not appear ANYWHERE in the response, and the only
    // signal about the secret is a boolean.
    expect(JSON.stringify(body)).not.toContain('SEALED-CIPHERTEXT-MUST-NOT-APPEAR');
    expect(body.hasClientSecret).toBe(true);
    expect(body.provider.oidcClientSecret).toBeUndefined();
    expect(body.provider.displayName).toBe('Okta');
  });

  it('reports provider:null (not an error) for an OWNER of an unconfigured org', async () => {
    db.orgIdentityProvider.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, { headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.provider).toBeNull();
    expect(body.hasClientSecret).toBe(false);
  });
});

describe('PUT /orgs/:orgId/sso — cross-org write is 404 and never mutates', () => {
  it('refuses a non-member with 404 and never upserts', async () => {
    const res = await fetch(`${base}/orgs/${ORG_B}/sso`, {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({
        protocol: 'OIDC',
        oidcIssuer: 'https://evil.example.com',
        oidcClientId: 'attacker',
        allowedEmailDomains: ['acme.com'],
        enabled: true,
      }),
    });
    expect(res.status).toBe(404);
    // THE assertion: refusal happened BEFORE any write.
    expect(db.orgIdentityProvider.upsert).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN of another org (404, not 403)', async () => {
    // Bob is ADMIN of B; he must not be able to reconfigure A.
    memberships[key('u-bob', ORG_B)] = { organizationId: ORG_B, userId: 'u-bob', role: 'ADMIN' };
    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, {
      method: 'PUT',
      headers: asUser({ id: 'u-bob', userId: 'u-bob', role: 'USER', email: 'bob@example.com' }),
      body: JSON.stringify({ protocol: 'SAML', samlEntryPoint: 'https://idp.example.com', samlIssuer: 'x', samlIdpCert: 'y' }),
    });
    expect(res.status).toBe(404);
    expect(db.orgIdentityProvider.upsert).not.toHaveBeenCalled();
  });

  it('403s a MEMBER of the org (they know it exists, they just lack the power)', async () => {
    memberships[key('u-bob', ORG_A)] = { organizationId: ORG_A, userId: 'u-bob', role: 'MEMBER' };
    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, {
      method: 'PUT',
      headers: asUser({ id: 'u-bob', userId: 'u-bob', role: 'USER', email: 'bob@example.com' }),
      body: JSON.stringify({ protocol: 'OIDC', oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c' }),
    });
    expect(res.status).toBe(403);
    expect(db.orgIdentityProvider.upsert).not.toHaveBeenCalled();
  });

  it('rejects a jitRole of OWNER or ADMIN at WRITE time (400, loudly)', async () => {
    for (const bad of ['OWNER', 'ADMIN']) {
      const res = await fetch(`${base}/orgs/${ORG_A}/sso`, {
        method: 'PUT',
        headers: asUser(ALICE),
        body: JSON.stringify({ protocol: 'OIDC', oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c', jitRole: bad }),
      });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(db.orgIdentityProvider.upsert).not.toHaveBeenCalled();
    }
  });

  it('rejects a non-bare email domain (a permissive allowlist is how it becomes "anything")', async () => {
    for (const bad of ['https://acme.com', '*.acme.com', 'acme.com/path']) {
      const res = await fetch(`${base}/orgs/${ORG_A}/sso`, {
        method: 'PUT',
        headers: asUser(ALICE),
        body: JSON.stringify({ protocol: 'OIDC', oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c', allowedEmailDomains: [bad] }),
      });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });

  it('does NOT enable federation as a side effect of saving config', async () => {
    db.orgIdentityProvider.upsert.mockResolvedValue({
      id: 'prov-1', organizationId: ORG_A, protocol: 'OIDC', enabled: false,
      displayName: null, oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c',
      samlEntryPoint: null, samlIssuer: null, allowedEmailDomains: [], jitEnabled: true,
      jitRole: 'MEMBER', createdAt: new Date(0), updatedAt: new Date(0), oidcClientSecret: null,
    });
    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, {
      method: 'PUT',
      headers: asUser(ALICE),
      body: JSON.stringify({ protocol: 'OIDC', oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c' }),
    });
    expect(res.status).toBe(200);
    const data = db.orgIdentityProvider.upsert.mock.calls[0][0];
    expect(data.create.enabled).toBe(false);
    expect(data.update.enabled).toBe(false);
  });
});

describe('DELETE /orgs/:orgId/sso', () => {
  it('refuses a non-member with 404 and never deletes', async () => {
    const res = await fetch(`${base}/orgs/${ORG_B}/sso`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(res.status).toBe(404);
    expect(db.orgIdentityProvider.deleteMany).not.toHaveBeenCalled();
  });

  it('lets an OWNER remove it (and reports what was removed)', async () => {
    db.orgIdentityProvider.deleteMany.mockResolvedValue({ count: 1 });
    const res = await fetch(`${base}/orgs/${ORG_A}/sso`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 1 });
  });
});

// ── The open login surface: 404 for an unconfigured/disabled tenant ─────────

describe('GET /orgs/:orgId/sso/start — open surface fails closed', () => {
  it('404s when the org has no provider (same answer as a nonexistent org)', async () => {
    db.orgIdentityProvider.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/orgs/${ORG_B}/sso/start`);
    expect(res.status).toBe(404);
  });

  it('404s when the provider exists but is DISABLED', async () => {
    db.orgIdentityProvider.findUnique.mockResolvedValue({
      id: 'prov-1', organizationId: ORG_A, protocol: 'OIDC', enabled: false,
      oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c',
      samlEntryPoint: null, samlIssuer: null, samlIdpCert: null,
      allowedEmailDomains: ['acme.com'], jitEnabled: true, jitRole: 'MEMBER',
    });
    const res = await fetch(`${base}/orgs/${ORG_A}/sso/start`);
    expect(res.status).toBe(404);
  });

  it('never echoes the secret on the open surface', async () => {
    db.orgIdentityProvider.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/orgs/${ORG_A}/sso/start`);
    const text = await res.text();
    expect(text).not.toContain('Secret');
  });
});

// ── JIT provisioning: the privilege clamp, on READ as well as write ─────────

describe('adaptiveJitRole — provisioning can never mint a senior role', () => {
  it('clamps OWNER and ADMIN down to MEMBER', () => {
    // This is the READ-side clamp: a row an older/other build wrote cannot
    // escalate. Asserted directly because it is the last line of defence.
    expect(adaptiveJitRole('OWNER')).toBe('MEMBER');
    expect(adaptiveJitRole('ADMIN')).toBe('MEMBER');
  });

  it('passes through the two assignable roles, case-insensitively', () => {
    expect(adaptiveJitRole('MEMBER')).toBe('MEMBER');
    expect(adaptiveJitRole('BILLING')).toBe('BILLING');
    expect(adaptiveJitRole('billing')).toBe('BILLING');
    expect(adaptiveJitRole('member')).toBe('MEMBER');
  });

  it('fails closed to MEMBER for null/unknown values', () => {
    for (const bad of [null, undefined, '', 'SUPERUSER', 'owner ']) {
      expect({ bad, role: adaptiveJitRole(bad as any) }).toEqual({ bad, role: 'MEMBER' });
    }
  });

  it('isJitAssignableRole agrees with the union (and rejects the senior roles)', () => {
    for (const role of JIT_ASSIGNABLE_ROLES) expect(isJitAssignableRole(role)).toBe(true);
    for (const bad of ['OWNER', 'ADMIN', 'nope', '']) expect(isJitAssignableRole(bad)).toBe(false);
  });
});

describe('jitAllows — the domain allowlist is CLOSED when empty', () => {
  const base = { jitEnabled: true };

  it('refuses everything when the allowlist is empty (never "any domain")', () => {
    expect(jitAllows({ ...base, allowedEmailDomains: [] }, 'anyone@acme.com')).toBe(false);
    expect(jitAllows({ ...base, allowedEmailDomains: null }, 'anyone@acme.com')).toBe(false);
  });

  it('refuses when provisioning is switched off, even for an allowed domain', () => {
    expect(jitAllows({ jitEnabled: false, allowedEmailDomains: ['acme.com'] }, 'a@acme.com')).toBe(false);
  });

  it('allows ONLY an exact domain match (no suffix/subdomain games)', () => {
    const provider = { ...base, allowedEmailDomains: ['acme.com'] };
    expect(jitAllows(provider, 'a@acme.com')).toBe(true);
    expect(jitAllows(provider, 'a@ACME.com')).toBe(true);
    // A lookalike domain must not match: this is the check that stops
    // "acme.com.evil.tld" and "notacme.com" from being provisioned.
    expect(jitAllows(provider, 'a@acme.com.evil.tld')).toBe(false);
    expect(jitAllows(provider, 'a@notacme.com')).toBe(false);
    expect(jitAllows(provider, 'a@sub.acme.com')).toBe(false);
  });

  it('refuses an address with no domain at all', () => {
    expect(jitAllows({ ...base, allowedEmailDomains: ['acme.com'] }, 'nodomain')).toBe(false);
  });
});

describe('normalizeEmailDomains', () => {
  it('lowercases, strips a leading @, and dedupes', () => {
    expect(normalizeEmailDomains(['@ACME.com', 'acme.com', 'beta.io'])).toEqual(['acme.com', 'beta.io']);
  });

  it('rejects a scheme, a wildcard or a path', () => {
    for (const bad of ['https://acme.com', '*.acme.com', 'acme.com/x']) {
      expect(() => normalizeEmailDomains([bad])).toThrow();
    }
  });
});

describe('emailDomain / safeReturnTo', () => {
  it('takes the part after the LAST @', () => {
    expect(emailDomain('a@b@acme.com')).toBe('acme.com');
    expect(emailDomain('no-at-sign')).toBe('');
  });

  it('accepts a same-origin absolute path', () => {
    expect(safeReturnTo('/chats/abc')).toBe('/chats/abc');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('refuses protocol-relative and absolute URLs (open-redirect guard)', () => {
    // "//evil.com" is the subtle one: browsers treat it as an off-site URL.
    for (const bad of ['//evil.com', 'https://evil.com', 'http://evil.com', '/\\evil.com', 'javascript:alert(1)']) {
      expect({ bad, value: safeReturnTo(bad) }).toEqual({ bad, value: null });
    }
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo('')).toBeNull();
  });
});

// ── resolveOrProvisionUser: the identity/adoption rules ────────────────────

describe('resolveOrProvisionUser', () => {
  const provider = {
    id: 'prov-1',
    organizationId: ORG_A,
    protocol: 'OIDC' as const,
    enabled: true,
    oidcIssuer: 'https://acme.okta.com',
    oidcClientId: 'c',
    samlEntryPoint: null,
    samlIssuer: null,
    samlIdpCert: null,
    allowedEmailDomains: ['acme.com'],
    jitEnabled: true,
    jitRole: 'MEMBER',
  };

  /** Wire $transaction to run the callback against the same mocked client. */
  function wireTransaction() {
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    db.user.create.mockResolvedValue({ id: 'u-new' });
    db.membership.create.mockResolvedValue({});
    db.federatedIdentity.create.mockResolvedValue({});
  }

  it('logs in an EXISTING link without provisioning', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    db.federatedIdentity.findUnique.mockResolvedValue({ userId: 'u-old', organizationId: ORG_A });
    db.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });
    db.federatedIdentity.updateMany.mockResolvedValue({ count: 1 });

    const out = await resolveOrProvisionUser({ provider, subject: 'sub-1', email: 'x@acme.com' });
    expect(out).toEqual({ userId: 'u-old', created: false, role: 'ADMIN' });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('refuses a linked user whose MEMBERSHIP was removed (403), even though the link survives', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    db.federatedIdentity.findUnique.mockResolvedValue({ userId: 'u-old', organizationId: ORG_A });
    db.membership.findUnique.mockResolvedValue(null);

    await expect(
      resolveOrProvisionUser({ provider, subject: 'sub-1', email: 'x@acme.com' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('provisions a MEMBER in THAT org only, and never isDefault', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    wireTransaction();
    db.federatedIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);

    const out = await resolveOrProvisionUser({
      provider,
      subject: 'sub-new',
      email: 'new@acme.com',
      firstName: 'New',
    });

    expect(out.created).toBe(true);
    const membershipArgs = db.membership.create.mock.calls[0][0];
    expect(membershipArgs.data.organizationId).toBe(ORG_A);
    expect(membershipArgs.data.role).toBe('MEMBER');
    // A federated invitee must NOT have their personal billing context repointed.
    expect(membershipArgs.data.isDefault).toBe(false);

    const linkArgs = db.federatedIdentity.create.mock.calls[0][0];
    expect(linkArgs.data.organizationId).toBe(ORG_A);
    expect(linkArgs.data.subject).toBe('sub-new');
  });

  it('clamps a STORED jitRole of OWNER to MEMBER at provisioning time', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    wireTransaction();
    db.federatedIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);

    // A row this build would never write — the read-side clamp must still hold.
    await resolveOrProvisionUser({
      provider: { ...provider, jitRole: 'OWNER' },
      subject: 'sub-esc',
      email: 'esc@acme.com',
    });

    expect(db.membership.create.mock.calls[0][0].data.role).toBe('MEMBER');
  });

  it('NEVER adopts an existing unlinked account by email (409, no takeover)', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    db.federatedIdentity.findUnique
      .mockResolvedValueOnce(null) // no (provider, subject) link
      .mockResolvedValueOnce(null); // and no existing link for that user+provider
    db.user.findUnique.mockResolvedValue({ id: 'u-victim' });

    await expect(
      resolveOrProvisionUser({ provider, subject: 'attacker-sub', email: 'victim@acme.com' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The decisive assertion: no new link was created pointing at the victim.
    expect(db.federatedIdentity.create).not.toHaveBeenCalled();
  });

  it('refuses JIT for a domain that is not allowed (403)', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    db.federatedIdentity.findUnique.mockResolvedValue(null);

    await expect(
      resolveOrProvisionUser({ provider, subject: 's', email: 'x@other.tld' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('refuses JIT entirely when provisioning is disabled (403)', async () => {
    const { resolveOrProvisionUser } = await import('./org-sso.service');
    db.federatedIdentity.findUnique.mockResolvedValue(null);

    await expect(
      resolveOrProvisionUser({
        provider: { ...provider, jitEnabled: false },
        subject: 's',
        email: 'x@acme.com',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Single-use login state ─────────────────────────────────────────────────

describe('claimLoginState — single use', () => {
  it('rejects a state that was already claimed or expired (count !== 1)', async () => {
    const { claimLoginState } = await import('./org-sso.service');
    db.ssoLoginState.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimLoginState('replayed-state')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('claims with a conditional UPDATE, not a read-then-write', async () => {
    const { claimLoginState } = await import('./org-sso.service');
    db.ssoLoginState.updateMany.mockResolvedValue({ count: 1 });
    db.ssoLoginState.findUnique.mockResolvedValue({ state: 's1', organizationId: ORG_A });

    await claimLoginState('s1');

    const where = db.ssoLoginState.updateMany.mock.calls[0][0].where;
    // The predicate IS the single-use guarantee: unconsumed AND unexpired.
    expect(where.consumedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });
});

// ── The service fails closed on an unusable config ─────────────────────────

describe('assertProviderUsable', () => {
  const baseProvider = {
    id: 'p', organizationId: ORG_A, protocol: 'OIDC' as const, enabled: true,
    oidcIssuer: 'https://acme.okta.com', oidcClientId: 'c',
    samlEntryPoint: null, samlIssuer: null, samlIdpCert: null,
    allowedEmailDomains: [], jitEnabled: true, jitRole: 'MEMBER',
  };

  it('refuses a disabled provider', async () => {
    const { assertProviderUsable } = await import('./org-sso.service');
    expect(() => assertProviderUsable({ ...baseProvider, enabled: false })).toThrow();
  });

  it('refuses an incomplete OIDC config', async () => {
    const { assertProviderUsable } = await import('./org-sso.service');
    expect(() => assertProviderUsable({ ...baseProvider, oidcClientId: null })).toThrow();
  });

  it('refuses an incomplete SAML config', async () => {
    const { assertProviderUsable } = await import('./org-sso.service');
    expect(() =>
      assertProviderUsable({ ...baseProvider, protocol: 'SAML', samlIdpCert: null }),
    ).toThrow();
  });

  it('accepts a fully configured provider', async () => {
    const { assertProviderUsable } = await import('./org-sso.service');
    expect(() => assertProviderUsable(baseProvider)).not.toThrow();
  });
});