/**
 * SCIM 2.0 provisioning tests (Phase 3 Enterprise, todo 76113a98).
 *
 * A SCIM credential is a machine account that can CREATE AND REMOVE ACCESS to a
 * tenant, so these pin the properties whose regression would be an actual breach:
 *
 *  1. THE TENANT COMES FROM THE TOKEN, NEVER THE URL. No SCIM route accepts an
 *     org parameter, so org A's token asking for org B's user gets 404 — the same
 *     answer a nonexistent id gets — and can never name org B at all.
 *  2. EVERY FAILED CREDENTIAL IS THE SAME 401. Unknown, revoked, expired and
 *     malformed all answer identically, so a probe cannot learn that a credential
 *     ever existed (the existence-oracle class the 404 rule closes).
 *  3. active:false IS A REAL DEPROVISION. It deactivates the MEMBERSHIP; the user
 *     and the row both survive, and access actually goes away (resolveMembership
 *     treats the row as absent). A flag nothing consults would make this feature
 *     theater, which is the defect org-access.ts exists to prevent.
 *  4. SCIM CANNOT MINT PRIVILEGE. A token is a credential an integration holds;
 *     if it could set an arbitrary role, whoever controls the integration could
 *     hand themselves tenant ownership. Roles are clamped to MEMBER/BILLING via
 *     the SAME helpers the SSO JIT path uses.
 *  5. ROTATION KILLS THE OLD SECRET IMMEDIATELY. Rotation rewrites the hash in
 *     place, so there is no window where two secrets both work.
 *
 * Hermetic, following the org-sso.test.ts / org-members.routes.test.ts idiom: the
 * REAL routers, the REAL scim-auth middleware and the REAL org-access predicate
 * run; prisma and logger are mocked and a bare express app listens on port 0.
 * Mocking the code under test is the review defect those files record, so it is
 * not repeated here.
 *
 * ONE HONEST LIMITATION, inherited: this harness maps AppError → statusCode with a
 * local middleware instead of mounting the real errorHandler, because error-handler
 * imports config/env (which process.exit(1)s without env vars and kills the worker).
 * Every assertion is on the STATUS the real handler would emit.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    scimToken: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    scimGroup: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express, { type Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import { createHash, randomUUID } from 'crypto';
import { scimRoutes } from './scim.routes';
import { scimTokenRoutes } from './scim-tokens.routes';
import { resolveMembership } from './org-access';
import { generateScimToken, hashScimToken, SCIM_TOKEN_PREFIX } from './scim-auth';

const db = prisma as unknown as Record<string, any>;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const USER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The human who owns org A — used by the token-management routes. */
const ALICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** A signed-in OWNER of org A (the token-management router mounts behind the guard). */
const userHeaders = {
  'content-type': 'application/json',
  'x-test-user': JSON.stringify({ id: ALICE_ID, userId: ALICE_ID, role: 'USER', email: 'alice@example.com' }),
};

/** The raw secret a test client presents. */
const RAW = SCIM_TOKEN_PREFIX + 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Stand-in for the app-level guard: the token-management router mounts AFTER
  // `authenticate` in app.ts, so these routes need a signed-in user.
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as any).user = JSON.parse(raw);
    next();
  });
  app.use('/scim/v2', scimRoutes);
  app.use(scimTokenRoutes);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
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

/** A live token row for org A. */
const liveToken = (overrides: Record<string, unknown> = {}) => ({
  id: TOKEN_A,
  organizationId: ORG_A,
  scopes: ['users:read', 'users:write', 'groups:read', 'groups:write'],
  revokedAt: null,
  expiresAt: null,
  ...overrides,
});

/** A membership row as MEMBERSHIP_SELECT returns it. */
const membershipRow = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_1,
  organizationId: ORG_A,
  role: 'MEMBER',
  deactivatedAt: null,
  scimExternalId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  user: { id: USER_1, email: 'one@example.com', name: 'One', firstName: 'One', lastName: null, isActive: true },
  ...overrides,
});

const auth = (raw = RAW) => ({ authorization: `Bearer ${raw}`, 'content-type': 'application/scim+json' });

beforeEach(() => {
  jest.clearAllMocks();
  db.scimToken.findUnique.mockResolvedValue(liveToken());
  // updateMany is used for the (throttled, fire-and-forget) lastUsedAt stamp
  // AND for revoke; the default satisfies both.
  db.scimToken.updateMany.mockResolvedValue({ count: 1 });
});

// ── 2. Every failed credential is the same 401 ─────────────────────────────

describe('credential failures are indistinguishable', () => {
  it('refuses a missing bearer with 401', async () => {
    const res = await fetch(`${base}/scim/v2/Users`);
    expect(res.status).toBe(401);
  });

  it('refuses an unknown token with 401', async () => {
    db.scimToken.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    expect(res.status).toBe(401);
  });

  it('refuses a REVOKED token with the same 401 (no "revoked" oracle)', async () => {
    db.scimToken.findUnique.mockResolvedValue(liveToken({ revokedAt: new Date() }));
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    expect(res.status).toBe(401);
    // The body must not distinguish this from "never existed".
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toMatch(/revoke/i);
  });

  it('refuses an EXPIRED token with 401', async () => {
    db.scimToken.findUnique.mockResolvedValue(liveToken({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    expect(res.status).toBe(401);
  });

  it('never looks up a value that is not a SCIM token at all', async () => {
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth('dgt_someotherapptoken') });
    expect(res.status).toBe(401);
    // Short-circuits on the prefix before touching the database.
    expect(db.scimToken.findUnique).not.toHaveBeenCalled();
  });

  it('stores only a sha256 hash, never the raw secret', async () => {
    db.membership.count.mockResolvedValue(0);
    db.membership.findMany.mockResolvedValue([]);
    await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    const arg = db.scimToken.findUnique.mock.calls[0][0] as { where: { tokenHash: string } };
    expect(arg.where.tokenHash).toBe(hashScimToken(RAW));
    expect(arg.where.tokenHash).not.toContain(RAW);
    expect(arg.where.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Scope refusal ──────────────────────────────────────────────────────────

describe('scope gating', () => {
  it('refuses a read with only write scope (403) — the caller is already known', async () => {
    db.scimToken.findUnique.mockResolvedValue(liveToken({ scopes: ['users:write'] }));
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    expect(res.status).toBe(403);
  });

  it('allows a read with the matching scope', async () => {
    db.membership.count.mockResolvedValue(0);
    db.membership.findMany.mockResolvedValue([]);
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    expect(res.status).toBe(200);
  });

  it('refuses a WRITE with only read scope', async () => {
    db.scimToken.findUnique.mockResolvedValue(liveToken({ scopes: ['users:read'] }));
    const res = await fetch(`${base}/scim/v2/Users`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ userName: 'new@example.com' }),
    });
    expect(res.status).toBe(403);
  });
});

// ── 1. The tenant comes from the token ─────────────────────────────────────

describe('cross-org isolation (tenant comes from the token)', () => {
  it('answers 404 for a user id belonging to ANOTHER org', async () => {
    // The lookup is scoped by (userId, organizationId-from-token): org B's user
    // is simply not found in org A's scope.
    db.membership.findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/scim/v2/Users/${USER_2}`, { headers: auth() });
    expect(res.status).toBe(404);
    // Prove the query could not have returned org B's row: the org predicate is
    // the TOKEN's org, not anything the caller supplied.
    const arg = db.membership.findUnique.mock.calls[0][0] as {
      where: { userId_organizationId: { userId: string; organizationId: string } };
    };
    expect(arg.where.userId_organizationId.organizationId).toBe(ORG_A);
  });

  it('gives the SAME 404 for a nonexistent id as for another tenant\'s id', async () => {
    db.membership.findUnique.mockResolvedValue(null);
    const foreign = await fetch(`${base}/scim/v2/Users/${USER_2}`, { headers: auth() });
    const ghost = await fetch(`${base}/scim/v2/Users/${randomUUID()}`, { headers: auth() });
    expect(foreign.status).toBe(ghost.status);
    expect(await foreign.json()).toEqual(await ghost.json());
  });

  it('scopes the group lookup to the token\'s org too', async () => {
    db.scimGroup.findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/scim/v2/Groups/${randomUUID()}`, { headers: auth() });
    expect(res.status).toBe(404);
    const arg = db.scimGroup.findFirst.mock.calls[0][0] as { where: { organizationId: string } };
    expect(arg.where.organizationId).toBe(ORG_A);
  });
});

// ── 3. active:false is a real deprovision ──────────────────────────────────

describe('deprovisioning removes ACCESS without deleting anyone', () => {
  it('a deprovisioned membership resolves as ABSENT — zero capabilities', async () => {
    db.membership.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      userId: USER_1,
      role: 'OWNER',
      deactivatedAt: new Date(),
    });
    // This is the arm that makes the whole feature real: if resolveMembership
    // still returned the row, `active:false` would be a flag nothing consults.
    await expect(resolveMembership(USER_1, ORG_A)).resolves.toBeNull();
  });

  it('an ACTIVE membership still resolves (the control — the filter is not blanket)', async () => {
    db.membership.findUnique.mockResolvedValue({
      organizationId: ORG_A,
      userId: USER_1,
      role: 'OWNER',
      deactivatedAt: null,
    });
    await expect(resolveMembership(USER_1, ORG_A)).resolves.toMatchObject({ role: 'OWNER' });
  });

  it('PATCH active:false DEACTIVATES and never deletes the membership or the user', async () => {
    db.membership.findUnique
      .mockResolvedValueOnce({ userId: USER_1 }) // existence check
      .mockResolvedValue(membershipRow({ deactivatedAt: new Date() }) as any);
    db.membership.count.mockResolvedValue(2); // another OWNER exists, so allowed
    db.membership.update.mockResolvedValue({});
    const res = await fetch(`${base}/scim/v2/Users/${USER_1}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }),
    });
    expect(res.status).toBe(200);
    const update = db.membership.update.mock.calls[0][0] as { data: { deactivatedAt: Date | null } };
    expect(update.data.deactivatedAt).toBeInstanceOf(Date);
    // NEITHER row is removed — deprovisioning is a state, not a deletion.
    expect(db.membership.delete).not.toHaveBeenCalled();
    expect(db.user.delete).toBeUndefined();
  });

  it('PATCH active:true REACTIVATES', async () => {
    db.membership.findUnique
      .mockResolvedValueOnce({ userId: USER_1 })
      .mockResolvedValue(membershipRow() as any);
    db.membership.update.mockResolvedValue({});
    const res = await fetch(`${base}/scim/v2/Users/${USER_1}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: true }] }),
    });
    expect(res.status).toBe(200);
    const update = db.membership.update.mock.calls[0][0] as { data: { deactivatedAt: Date | null } };
    expect(update.data.deactivatedAt).toBeNull();
  });

  it('DELETE means deprovision, not destruction (204 + deactivatedAt set)', async () => {
    db.membership.findUnique.mockResolvedValue({ userId: USER_1 });
    db.membership.count.mockResolvedValue(3);
    db.membership.update.mockResolvedValue({});
    const res = await fetch(`${base}/scim/v2/Users/${USER_1}`, { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(204);
    const update = db.membership.update.mock.calls[0][0] as { data: { deactivatedAt: Date | null } };
    expect(update.data.deactivatedAt).toBeInstanceOf(Date);
  });

  it('REFUSES to deprovision the last active OWNER (that would orphan the tenant)', async () => {
    db.membership.findUnique.mockResolvedValue({ userId: USER_1, role: 'OWNER', deactivatedAt: null });
    db.membership.count.mockResolvedValue(1); // the caller would be the last one
    const res = await fetch(`${base}/scim/v2/Users/${USER_1}`, { method: 'DELETE', headers: auth() });
    expect(res.status).toBe(409);
    // And nothing was written.
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('reports active:false on a READ of a deprovisioned user (the state is visible)', async () => {
    db.membership.findUnique.mockResolvedValue(membershipRow({ deactivatedAt: new Date() }) as any);
    const res = await fetch(`${base}/scim/v2/Users/${USER_1}`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});

// ── 4. SCIM cannot mint privilege ──────────────────────────────────────────

describe('provisioning cannot mint OWNER or ADMIN', () => {
  it('coerces a requested OWNER role down to MEMBER on create', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const txUserCreate = jest.fn().mockResolvedValue({ id: USER_1 });
    const txMembershipCreate = jest.fn().mockResolvedValue({});
    db.$transaction.mockImplementation(async (fn: any) =>
      fn({ user: { create: txUserCreate }, membership: { create: txMembershipCreate } }),
    );
    db.membership.findUnique.mockResolvedValue(membershipRow() as any);
    const res = await fetch(`${base}/scim/v2/Users`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        userName: 'sneaky@example.com',
        'urn:digby:params:scim:schemas:extension:2.0:OrgRole': { role: 'OWNER' },
      }),
    });
    expect(res.status).toBe(201);
    // THE ASSERTION THAT MATTERS: the role actually WRITTEN is MEMBER. Asserting
    // only the status would pass even if OWNER were stored.
    expect(txMembershipCreate).toHaveBeenCalledTimes(1);
    const data = (txMembershipCreate.mock.calls[0][0] as { data: { role: string } }).data;
    expect(data.role).toBe('MEMBER');
    expect(data.role).not.toBe('OWNER');
  });

  it('coerces a requested ADMIN role down to MEMBER on create', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const txMembershipCreate = jest.fn().mockResolvedValue({});
    db.$transaction.mockImplementation(async (fn: any) =>
      fn({ user: { create: jest.fn().mockResolvedValue({ id: USER_1 }) }, membership: { create: txMembershipCreate } }),
    );
    db.membership.findUnique.mockResolvedValue(membershipRow() as any);
    await fetch(`${base}/scim/v2/Users`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ userName: 'sneaky2@example.com', role: 'ADMIN' }),
    });
    const data = (txMembershipCreate.mock.calls[0][0] as { data: { role: string } }).data;
    expect(data.role).toBe('MEMBER');
  });

  it('a provisioned account gets NO usable password (it is IdP-governed)', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const txUserCreate = jest.fn().mockResolvedValue({ id: USER_1 });
    db.$transaction.mockImplementation(async (fn: any) =>
      fn({ user: { create: txUserCreate }, membership: { create: jest.fn().mockResolvedValue({}) } }),
    );
    db.membership.findUnique.mockResolvedValue(membershipRow() as any);
    await fetch(`${base}/scim/v2/Users`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ userName: 'nopw@example.com' }),
    });
    const data = (txUserCreate.mock.calls[0][0] as { data: { password: string; emailVerifiedAt: Date } }).data;
    // A random 64-hex string nobody holds — and the address is verified because
    // the IdP asserted it (mailing ourselves a link would be a downgrade).
    expect(data.password).toMatch(/^[0-9a-f]{64,}$/);
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('is the SAME clamp the SSO JIT path uses (no second role policy)', async () => {
    // A guard against the tempting "just this once" literal: the helpers the SSO
    // path exports are the authority, and OWNER/ADMIN are outside their set.
    const sso = await import('./org-sso.service');
    expect(sso.isJitAssignableRole('OWNER')).toBe(false);
    expect(sso.isJitAssignableRole('ADMIN')).toBe(false);
    expect(sso.adaptiveJitRole('OWNER')).toBe('MEMBER');
    expect(sso.adaptiveJitRole('ADMIN')).toBe('MEMBER');
  });
});

// ── 5. Rotation kills the old secret immediately ───────────────────────────

describe('token lifecycle', () => {
  it('generates a prefixed, high-entropy secret and stores only its hash', () => {
    const { raw, tokenHash, tokenPrefix } = generateScimToken();
    expect(raw.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
    expect(raw.length).toBeGreaterThan(40);
    expect(tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(tokenPrefix).toBe(raw.slice(0, 13));
    expect(tokenHash).not.toContain(raw);
  });

  it('two mints never collide', () => {
    const a = generateScimToken();
    const b = generateScimToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('rotation rewrites the hash IN PLACE, so the old secret stops verifying', async () => {
    // The invariant is a WRITE PROPERTY, so assert on the write. Rotation must
    // update the SAME row (not delete+create), and the stored hash must change —
    // that is what makes the previous secret stop verifying the instant it lands,
    // with no window where both work.
    db.membership.findUnique.mockResolvedValue({
      organizationId: ORG_A, userId: ALICE_ID, role: 'OWNER', deactivatedAt: null,
    });
    db.scimToken.findFirst.mockResolvedValue({ id: TOKEN_A, revokedAt: null });
    db.scimToken.update.mockResolvedValue({
      id: TOKEN_A, name: 'x', tokenPrefix: 'scim_', scopes: [], expiresAt: null,
      lastUsedAt: null, revokedAt: null, rotatedAt: new Date(), createdAt: new Date(),
    });

    const res = await fetch(`${base}/orgs/${ORG_A}/scim/tokens/${TOKEN_A}/rotate`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    // The secret handed back is NEW and usable-shaped.
    const body = (await res.json()) as { data: { secret: string } };
    expect(body.data.secret.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
    expect(body.data.secret).not.toBe(RAW);

    // ONE update on the SAME row, and the stored hash is the NEW secret's hash.
    expect(db.scimToken.update).toHaveBeenCalledTimes(1);
    const call = db.scimToken.update.mock.calls[0][0] as {
      where: { id: string };
      data: { tokenHash: string; rotatedAt: Date; lastUsedAt: null };
    };
    expect(call.where.id).toBe(TOKEN_A);
    expect(call.data.tokenHash).toBe(hashScimToken(body.data.secret));
    // The OLD secret's hash is gone — presenting it would now 404 to null.
    expect(call.data.tokenHash).not.toBe(hashScimToken(RAW));
    expect(call.data.rotatedAt).toBeInstanceOf(Date);
    // Rotation never creates a second row (no window with two live secrets).
    expect(db.scimToken.create).not.toHaveBeenCalled();
  });

  it('refuses to rotate a credential belonging to ANOTHER org (404, scoped query)', async () => {
    db.membership.findUnique.mockResolvedValue({
      organizationId: ORG_A, userId: ALICE_ID, role: 'OWNER', deactivatedAt: null,
    });
    // The lookup is scoped by (id, organizationId) — org B's token is not found.
    db.scimToken.findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/orgs/${ORG_A}/scim/tokens/${TOKEN_A}/rotate`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(db.scimToken.update).not.toHaveBeenCalled();
    const arg = db.scimToken.findFirst.mock.calls[0][0] as { where: { organizationId: string } };
    expect(arg.where.organizationId).toBe(ORG_A);
  });

  it('refuses rotation of an already-revoked token (409, mint a new one)', async () => {
    db.membership.findUnique.mockResolvedValue({
      organizationId: ORG_A, userId: ALICE_ID, role: 'OWNER', deactivatedAt: null,
    });
    db.scimToken.findFirst.mockResolvedValue({ id: TOKEN_A, revokedAt: new Date() });
    const res = await fetch(`${base}/orgs/${ORG_A}/scim/tokens/${TOKEN_A}/rotate`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(db.scimToken.update).not.toHaveBeenCalled();
  });
});

// ── RFC 7644 shapes ────────────────────────────────────────────────────────

describe('RFC 7644 / 7643 shapes', () => {
  it('lists users as a ListResponse with totalResults and Resources', async () => {
    db.membership.count.mockResolvedValue(1);
    db.membership.findMany.mockResolvedValue([membershipRow()]);
    const res = await fetch(`${base}/scim/v2/Users`, { headers: auth() });
    const body = (await res.json()) as Record<string, any>;
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(body.totalResults).toBe(1);
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0].userName).toBe('one@example.com');
    expect(body.Resources[0].meta.location).toContain('/scim/v2/Users/');
  });

  it('returns a SCIM error body, not { error }, on 401', async () => {
    const res = await fetch(`${base}/scim/v2/Users`);
    const body = (await res.json()) as Record<string, any>;
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(body.status).toBe('401');
  });

  it('announces capabilities via ServiceProviderConfig', async () => {
    const res = await fetch(`${base}/scim/v2/ServiceProviderConfig`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.patch.supported).toBe(true);
    expect(body.filter.supported).toBe(true);
  });
});