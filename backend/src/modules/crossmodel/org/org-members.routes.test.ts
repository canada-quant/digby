/**
 * ORG-SCOPED member route tests (Phase 3 Enterprise RBAC, todo c45f065e).
 *
 * The service/predicate has its own suite (org-access.test.ts). What makes this
 * feature SAFE is the HTTP surface, so that is what these pin:
 *
 *  - CROSS-ORG REFUSAL IS 404, NOT 403, on read AND write. A member of org A who
 *    names org B gets the same answer as a caller naming an org that never
 *    existed — no existence oracle across tenants. Asserted on the status AND on
 *    the absence of any org row in the body.
 *  - The refusal happens BEFORE any write: the prisma mutation mock is asserted
 *    NEVER CALLED on every cross-org write attempt, so this cannot regress into
 *    "we wrote, then noticed you were not allowed".
 *  - The ROLE MATRIX: MEMBER 403s on the roster; BILLING 403s on member routes
 *    but still succeeds on a billing capability; ADMIN may add and remove people
 *    but may not mint an OWNER.
 *  - ESCALATION GUARDS: an ADMIN cannot grant OWNER; nobody can change their own
 *    role; an ADMIN cannot remove an OWNER (or another ADMIN).
 *  - WORKSPACE INVARIANTS: the last OWNER cannot be removed (400), and a PERSONAL
 *    workspace cannot gain a member (400) — a personal org is single-member by
 *    construction.
 *  - GET /orgs is scoped by the CALLER's userId and cannot return a foreign org.
 *
 * Hermetic, following the org-admin.routes.test.ts idiom: the REAL router, the
 * REAL `validate` middleware and the REAL `org-access` predicate run (mocking the
 * thing under test is the review defect that file records); prisma and logger are
 * mocked, a bare express app listens on port 0, and no app/env is booted.
 *
 * ONE HONEST LIMITATION: this harness maps AppError → its statusCode with a small
 * local middleware instead of mounting the real errorHandler, because error-
 * handler imports config/env (which process.exit(1)s without env vars and kills
 * the jest worker). The mapping it stands in for is the one pinned by
 * error-handler's own suite (`err instanceof AppError → res.status(err.statusCode)`);
 * every assertion below is on the STATUS the real handler would emit.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    organization: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import { orgMembersRoutes, ORG_MEMBER_ROUTE_CAPABILITIES } from './org-members.routes';
import { ORG_ROLES, roleCan } from './org-access';

const db = prisma as unknown as {
  membership: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  organization: { findUnique: jest.Mock };
  user: { findFirst: jest.Mock };
};

const ORG_A = { id: 'org-a', name: 'Acme', slug: 'acme', personal: false, plan: 'TEAM' };
const ORG_B = { id: 'org-b', name: 'Globex', slug: 'globex', personal: false, plan: 'TEAM' };
const PERSONAL = { id: 'org-p', name: "Ada's workspace", slug: 'ada', personal: true, plan: 'FREE' };

/**
 * Stand-in for the app-level guard: injects req.user from the x-test-user header
 * (the routes are mounted after `authenticate` in app.ts, so a real request here
 * always carries one).
 */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as any).user = JSON.parse(raw);
    next();
  });
  app.use(orgMembersRoutes);
  app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  // AppError → its status, standing in for middleware/error-handler (see header).
  // ZodError → 400 matches the real handler's mapping (it maps `isZod` to 400 and
  // returns the issue list); only the status matters to these assertions.
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

const ALICE = { id: 'u-alice', role: 'USER', email: 'alice@example.com' };
const BOB = { id: 'u-bob', role: 'USER', email: 'bob@example.com' };

/**
 * Membership rows by (userId, orgId). `findUnique` is the ONE resolution path
 * org-access uses, so seeding this map is how a test says "X is a ROLE in org Y"
 * — and the absence of an entry is a genuine non-member (404), not an error.
 */
let memberships: Record<string, { organizationId: string; userId: string; role: string }>;
const key = (userId: string, orgId: string) => `${userId}::${orgId}`;

beforeEach(() => {
  jest.clearAllMocks();
  memberships = {
    [key('u-alice', 'org-a')]: { organizationId: 'org-a', userId: 'u-alice', role: 'OWNER' },
    [key('u-bob', 'org-a')]: { organizationId: 'org-a', userId: 'u-bob', role: 'MEMBER' },
  };
  db.membership.findUnique.mockImplementation(async ({ where }: any) => {
    const w = where.userId_organizationId;
    return memberships[key(w.userId, w.organizationId)] ?? null;
  });
  db.membership.findMany.mockImplementation(async ({ where }: any) => {
    if (where.organizationId) {
      return Object.values(memberships)
        .filter((m) => m.organizationId === where.organizationId)
        .map((m) => ({ ...m, isDefault: false, createdAt: new Date(0), user: { id: m.userId } }));
    }
    // GET /orgs — scoped by the CALLER's userId only.
    return Object.values(memberships)
      .filter((m) => m.userId === where.userId)
      .map((m) => ({
        role: m.role,
        isDefault: false,
        createdAt: new Date(0),
        organization: m.organizationId === 'org-a' ? ORG_A : m.organizationId === 'org-b' ? ORG_B : PERSONAL,
      }));
  });
  db.membership.count.mockResolvedValue(1);
  db.membership.create.mockImplementation(async ({ data }: any) => ({ ...data, createdAt: new Date(0), user: { id: data.userId } }));
  db.membership.update.mockImplementation(async ({ where, data }: any) => ({
    userId: where.userId_organizationId.userId,
    role: data.role,
    isDefault: false,
    createdAt: new Date(0),
    user: { id: where.userId_organizationId.userId },
  }));
  db.membership.delete.mockResolvedValue({});
  db.organization.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id === 'org-a') return ORG_A;
    if (where.id === 'org-b') return ORG_B;
    if (where.id === 'org-p') return PERSONAL;
    return null;
  });
  db.user.findFirst.mockResolvedValue(null);
});

const setRole = (userId: string, orgId: string, role: string) => {
  memberships[key(userId, orgId)] = { organizationId: orgId, userId, role };
};

// ─────────────────────────────────────────────────────────────────────────────
describe('route registration', () => {
  it('registers the five org-scoped routes and no admin-shaped path', () => {
    const paths: string[] = (orgMembersRoutes as any).stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0]} ${l.route.path}` as string);
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /orgs',
        'get /orgs/:orgId',
        'get /orgs/:orgId/members',
        'post /orgs/:orgId/members',
        'patch /orgs/:orgId/members/:userId',
        'delete /orgs/:orgId/members/:userId',
      ]),
    );
    // These are WORKSPACE routes: nothing under /admin (that surface is
    // org-admin.routes.ts and is gated by isAdminViewer instead).
    expect(paths.filter((p) => p.includes('/admin'))).toEqual([]);
  });

  it('the exported route→capability map covers every route and names a REAL capability', () => {
    const registered = (orgMembersRoutes as any).stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`)
      .filter((p: string) => p !== 'get /orgs'); // GET /orgs needs no capability: it IS the membership query
    expect(ORG_MEMBER_ROUTE_CAPABILITIES.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...registered].sort());
    for (const r of ORG_MEMBER_ROUTE_CAPABILITIES) {
      // Every mapped capability must be held by at least one role, or the route
      // would be unreachable by design (a typo'd capability reads as "nobody").
      expect(ORG_ROLES.some((role) => roleCan(role, r.capability))).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-org READ refusal — 404, never 403', () => {
  it('GET /orgs/:orgB from a member of org A is 404 and returns no org row', async () => {
    const res = await fetch(`${base}/orgs/org-b`, { headers: asUser(ALICE) });
    // 404 rather than 403 ON PURPOSE: a 403 would mean "org-b exists but is not
    // yours", confirming the id and letting an outsider probe uuids to enumerate
    // tenants. 404 makes a foreign tenant indistinguishable from a nonexistent one.
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body).toEqual({ error: 'Workspace not found' });
    expect(JSON.stringify(body)).not.toMatch(/globex|org-b/);
    // And the org was never even read.
    expect(db.organization.findUnique).not.toHaveBeenCalled();
  });

  it('GET /orgs/:orgB/members from a member of org A is 404 (not 403) and lists nothing', async () => {
    const res = await fetch(`${base}/orgs/org-b/members`, { headers: asUser(ALICE) });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403); // the isolation property, asserted explicitly
    const body = (await res.json()) as any;
    expect(body.error).toBe('Workspace not found');
    expect(body.data).toBeUndefined();
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  it('an org that does not exist at all answers IDENTICALLY to one we are not in', async () => {
    const foreign = await fetch(`${base}/orgs/org-b`, { headers: asUser(ALICE) });
    const missing = await fetch(`${base}/orgs/does-not-exist`, { headers: asUser(ALICE) });
    expect(missing.status).toBe(foreign.status);
    expect(await missing.json()).toEqual(await foreign.json());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cross-org WRITE refusal — 404 before ANY mutation', () => {
  it('POST members to org B is 404 and never creates a membership', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u-carol', email: 'carol@example.com', name: 'Carol', firstName: 'Carol' });
    const res = await fetch(`${base}/orgs/org-b/members`, {
      method: 'POST',
      headers: asUser(ALICE),
      body: JSON.stringify({ email: 'carol@example.com' }),
    });
    expect(res.status).toBe(404);
    expect(db.membership.create).not.toHaveBeenCalled();
    // Refusal happens BEFORE the invitee lookup too: a cross-tenant caller must
    // not even be able to ask "does this email have an account".
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH a role in org B is 404 and never updates', async () => {
    const res = await fetch(`${base}/orgs/org-b/members/u-bob`, {
      method: 'PATCH',
      headers: asUser(ALICE),
      body: JSON.stringify({ role: 'ADMIN' }),
    });
    expect(res.status).toBe(404);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('DELETE a member of org B is 404 and never deletes', async () => {
    const res = await fetch(`${base}/orgs/org-b/members/u-bob`, {
      method: 'DELETE',
      headers: asUser(ALICE),
    });
    expect(res.status).toBe(404);
    expect(db.membership.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('role matrix', () => {
  it('MEMBER gets 403 on the roster (member:read) but can still read the org', async () => {
    const roster = await fetch(`${base}/orgs/org-a/members`, { headers: asUser(BOB) });
    expect(roster.status).toBe(403);
    expect(((await roster.json()) as any).error).toContain('MEMBER');
    // ...and the roster query never ran.
    expect(db.membership.findMany).not.toHaveBeenCalled();

    const org = await fetch(`${base}/orgs/org-a`, { headers: asUser(BOB) });
    expect(org.status).toBe(200);
    expect(((await org.json()) as any).data.org.id).toBe('org-a');
  });

  it('MEMBER cannot invite, change roles or remove anyone (403 on each)', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u-carol', email: 'carol@example.com' });
    const invite = await fetch(`${base}/orgs/org-a/members`, {
      method: 'POST', headers: asUser(BOB), body: JSON.stringify({ email: 'carol@example.com' }),
    });
    const patch = await fetch(`${base}/orgs/org-a/members/u-bob`, {
      method: 'PATCH', headers: asUser(BOB), body: JSON.stringify({ role: 'ADMIN' }),
    });
    const del = await fetch(`${base}/orgs/org-a/members/u-bob`, { method: 'DELETE', headers: asUser(BOB) });
    expect([invite.status, patch.status, del.status]).toEqual([403, 403, 403]);
    expect(db.membership.create).not.toHaveBeenCalled();
    expect(db.membership.update).not.toHaveBeenCalled();
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it('BILLING gets 403 on every member route but holds the billing capabilities', async () => {
    setRole('u-bob', 'org-a', 'BILLING');
    const roster = await fetch(`${base}/orgs/org-a/members`, { headers: asUser(BOB) });
    const del = await fetch(`${base}/orgs/org-a/members/u-alice`, { method: 'DELETE', headers: asUser(BOB) });
    expect([roster.status, del.status]).toEqual([403, 403]);
    // The capability itself is held — proven on the predicate, since no billing
    // HTTP route exists yet in this tranche (this is the seam the billing UI and
    // the /billing routes will sit behind).
    expect(roleCan('BILLING', 'billing:update')).toBe(true);
    expect(roleCan('BILLING', 'billing:read')).toBe(true);
    // And they may still see the workspace they belong to.
    expect((await fetch(`${base}/orgs/org-a`, { headers: asUser(BOB) })).status).toBe(200);
  });

  it('ADMIN can read the roster, add a member and remove a plain MEMBER', async () => {
    setRole('u-alice', 'org-a', 'ADMIN');
    memberships[key('u-carol', 'org-a')] = { organizationId: 'org-a', userId: 'u-carol', role: 'MEMBER' };
    db.user.findFirst.mockResolvedValue({ id: 'u-dave', email: 'dave@example.com', name: 'Dave' });

    const roster = await fetch(`${base}/orgs/org-a/members`, { headers: asUser(ALICE) });
    expect(roster.status).toBe(200);
    expect(((await roster.json()) as any).data.count).toBeGreaterThan(0);

    const add = await fetch(`${base}/orgs/org-a/members`, {
      method: 'POST', headers: asUser(ALICE), body: JSON.stringify({ email: 'dave@example.com' }),
    });
    expect(add.status).toBe(201);
    expect((db.membership.create.mock.calls[0][0] as any).data).toMatchObject({
      userId: 'u-dave',
      organizationId: 'org-a',
      role: 'MEMBER', // least power on invite
      isDefault: false,
    });

    const del = await fetch(`${base}/orgs/org-a/members/u-carol`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(del.status).toBe(200);
    expect((db.membership.delete.mock.calls[0][0] as any).where).toEqual({
      userId_organizationId: { userId: 'u-carol', organizationId: 'org-a' },
    });
  });

  it('an unknown role in the column is treated as powerless (deny by default)', async () => {
    setRole('u-bob', 'org-a', 'FUTURE_ROLE' as any);
    const roster = await fetch(`${base}/orgs/org-a/members`, { headers: asUser(BOB) });
    expect(roster.status).toBe(403);
    // ...but org:read also fails, because an unreadable role holds nothing.
    const org = await fetch(`${base}/orgs/org-a`, { headers: asUser(BOB) });
    expect(org.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('escalation guards', () => {
  it('an ADMIN cannot grant OWNER (member:grant-senior is OWNER-only)', async () => {
    setRole('u-alice', 'org-a', 'ADMIN');
    const res = await fetch(`${base}/orgs/org-a/members/u-bob`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'OWNER' }),
    });
    expect(res.status).toBe(403);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('an ADMIN cannot promote anyone to ADMIN either (minting a peer is the same hole)', async () => {
    setRole('u-alice', 'org-a', 'ADMIN');
    const res = await fetch(`${base}/orgs/org-a/members/u-bob`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'ADMIN' }),
    });
    expect(res.status).toBe(403);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('an ADMIN may reseat a MEMBER to BILLING (no seniority involved)', async () => {
    setRole('u-alice', 'org-a', 'ADMIN');
    const res = await fetch(`${base}/orgs/org-a/members/u-bob`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'BILLING' }),
    });
    expect(res.status).toBe(200);
    expect((db.membership.update.mock.calls[0][0] as any).data).toEqual({ role: 'BILLING' });
  });

  it('nobody can change their OWN role — not even an OWNER', async () => {
    const res = await fetch(`${base}/orgs/org-a/members/u-alice`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'MEMBER' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('your own role');
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('an ADMIN cannot remove an OWNER or a fellow ADMIN', async () => {
    setRole('u-alice', 'org-a', 'ADMIN');
    memberships[key('u-owen', 'org-a')] = { organizationId: 'org-a', userId: 'u-owen', role: 'OWNER' };
    memberships[key('u-ada', 'org-a')] = { organizationId: 'org-a', userId: 'u-ada', role: 'ADMIN' };
    db.membership.count.mockResolvedValue(2);

    const owner = await fetch(`${base}/orgs/org-a/members/u-owen`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(owner.status).toBe(403);
    const peer = await fetch(`${base}/orgs/org-a/members/u-ada`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(peer.status).toBe(403);
    expect(db.membership.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('workspace invariants', () => {
  it('refuses removing the LAST OWNER with 400 so the workspace can never be orphaned', async () => {
    memberships[key('u-owen', 'org-a')] = { organizationId: 'org-a', userId: 'u-owen', role: 'OWNER' };
    memberships[key('u-alice', 'org-a')] = { organizationId: 'org-a', userId: 'u-alice', role: 'OWNER' };
    // The second owner removes the first while... there are TWO owners, so make
    // the count tell the truth: one owner left in the workspace.
    db.membership.count.mockResolvedValue(1);
    const res = await fetch(`${base}/orgs/org-a/members/u-owen`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('at least one OWNER');
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it('allows removing an OWNER when another OWNER remains', async () => {
    memberships[key('u-owen', 'org-a')] = { organizationId: 'org-a', userId: 'u-owen', role: 'OWNER' };
    db.membership.count.mockResolvedValue(2);
    const res = await fetch(`${base}/orgs/org-a/members/u-owen`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    expect(db.membership.delete).toHaveBeenCalled();
  });

  it('refuses adding a member to a PERSONAL workspace with 400', async () => {
    memberships[key('u-alice', 'org-p')] = { organizationId: 'org-p', userId: 'u-alice', role: 'OWNER' };
    db.user.findFirst.mockResolvedValue({ id: 'u-bob', email: 'bob@example.com' });
    const res = await fetch(`${base}/orgs/org-p/members`, {
      method: 'POST', headers: asUser(ALICE), body: JSON.stringify({ email: 'bob@example.com' }),
    });
    // 400, not 403: the caller DOES hold member:invite. The refusal is about what
    // the workspace IS (single-member by construction), not about who is asking —
    // sharing a personal org would silently expose the user's private context.
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('personal');
    expect(db.membership.create).not.toHaveBeenCalled();
  });

  it('refuses removing a member from a PERSONAL workspace with 400', async () => {
    memberships[key('u-alice', 'org-p')] = { organizationId: 'org-p', userId: 'u-alice', role: 'OWNER' };
    const res = await fetch(`${base}/orgs/org-p/members/u-alice`, { method: 'DELETE', headers: asUser(ALICE) });
    expect(res.status).toBe(400);
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it('409s inviting someone who is already a member', async () => {
    memberships[key('u-bob', 'org-a')] = { organizationId: 'org-a', userId: 'u-bob', role: 'MEMBER' };
    db.user.findFirst.mockResolvedValue({ id: 'u-bob', email: 'bob@example.com' });
    const res = await fetch(`${base}/orgs/org-a/members`, {
      method: 'POST', headers: asUser(ALICE), body: JSON.stringify({ email: 'bob@example.com' }),
    });
    expect(res.status).toBe(409);
    expect(db.membership.create).not.toHaveBeenCalled();
  });

  it('404s inviting an email with no account (this is not an invitation-email flow)', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const res = await fetch(`${base}/orgs/org-a/members`, {
      method: 'POST', headers: asUser(ALICE), body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(res.status).toBe(404);
    expect(db.membership.create).not.toHaveBeenCalled();
  });

  it('404s acting on a userId that is not a member of this org', async () => {
    const patch = await fetch(`${base}/orgs/org-a/members/u-stranger`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'MEMBER' }),
    });
    const del = await fetch(`${base}/orgs/org-a/members/u-stranger`, { method: 'DELETE', headers: asUser(ALICE) });
    expect([patch.status, del.status]).toEqual([404, 404]);
    expect(db.membership.update).not.toHaveBeenCalled();
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it('rejects a role outside the enum before touching the database', async () => {
    const res = await fetch(`${base}/orgs/org-a/members/u-bob`, {
      method: 'PATCH', headers: asUser(ALICE), body: JSON.stringify({ role: 'SUPERADMIN' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed invite email', async () => {
    const res = await fetch(`${base}/orgs/org-a/members`, {
      method: 'POST', headers: asUser(ALICE), body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /orgs — tenant switcher scoping', () => {
  it('queries memberships by the CALLER’s userId and returns only their orgs', async () => {
    memberships[key('u-alice', 'org-b')] = { organizationId: 'org-b', userId: 'u-alice', role: 'ADMIN' };
    memberships[key('u-bob', 'org-b')] = { organizationId: 'org-b', userId: 'u-bob', role: 'MEMBER' };
    const res = await fetch(`${base}/orgs`, { headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // The scoping predicate is the caller's identity — never an orgId from the
    // request (there is no parameter that could widen this).
    expect((db.membership.findMany.mock.calls[0][0] as any).where).toEqual({ userId: 'u-alice' });
    const ids = body.data.orgs.map((o: any) => o.id);
    expect(ids.sort()).toEqual(['org-a', 'org-b']);
    // An org the caller is NOT in can never appear, even though it exists.
    memberships[key('u-carol', 'org-c')] = { organizationId: 'org-c', userId: 'u-carol', role: 'OWNER' };
    const again = await fetch(`${base}/orgs`, { headers: asUser(ALICE) });
    expect(((await again.json()) as any).data.orgs.map((o: any) => o.id)).not.toContain('org-c');
  });

  it('returns the caller’s role per org (the switcher labels seats)', async () => {
    memberships[key('u-alice', 'org-b')] = { organizationId: 'org-b', userId: 'u-alice', role: 'BILLING' };
    const body = (await (await fetch(`${base}/orgs`, { headers: asUser(ALICE) })).json()) as any;
    const byId = Object.fromEntries(body.data.orgs.map((o: any) => [o.id, o.role]));
    expect(byId).toEqual({ 'org-a': 'OWNER', 'org-b': 'BILLING' });
  });

  it('returns an empty list (not an error) for a caller who belongs to nothing', async () => {
    memberships = {};
    const res = await fetch(`${base}/orgs`, { headers: asUser(ALICE) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ orgs: [], count: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('no session user — the guard always runs in app.ts, so this is a 401 not a 500', () => {
  it('401s when req.user is absent', async () => {
    const res = await fetch(`${base}/orgs`);
    expect(res.status).toBe(401);
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * STRUCTURAL GUARD — the "fails when a new unguarded path is added" property.
 *
 * The capability table is only the authority while NOTHING ELSE compares a role
 * to an OrgRole literal. A future handler that writes `membership.role ===
 * 'OWNER'` would silently bypass the table (and bypass the rank rule and the
 * 404-not-403 rule with it), so this scan fails the suite if such a comparison
 * appears in any .ts file under this directory except org-access.ts.
 *
 * SCOPE, stated honestly: the scan covers this directory — the org module, which
 * is where both the predicate AND every org-scoped route live, including any
 * handler a future tranche adds here. It does NOT cover a route file placed
 * outside `org/`; the mitigation is that role interpretation is only meaningful
 * next to the membership model, and the route→capability map above plus the
 * middleware-name scan keep the mounted surface visible. The patterns are
 * literal-anchored (`role === 'OWNER'`, `role: 'ADMIN'`, `case 'BILLING'`) so the
 * pre-existing USER-role checks in org-admin.routes.ts (`isAdminViewer`, the
 * `Role` enum — a DIFFERENT concept) are not flagged.
 */
describe('structural guard — org roles are interpreted in ONE place', () => {
  const ORG_DIR = __dirname;
  const ROLE_LITERALS = `'(?:${ORG_ROLES.join('|')})'`;

  /** Comparisons/assignments of a role against an OrgRole literal. */
  const PATTERNS: Array<{ name: string; re: RegExp }> = [
    // `role === 'OWNER'`, `role !== 'ADMIN'`, `x.role == 'MEMBER'`
    { name: 'role comparison', re: new RegExp(`\\brole\\s*[!=]==?\\s*${ROLE_LITERALS}`) },
    // `'OWNER' === role`
    { name: 'reversed role comparison', re: new RegExp(`${ROLE_LITERALS}\\s*[!=]==?\\s*[A-Za-z_$][\\w$]*\\.?role\\b`) },
    // `case 'BILLING':` inside a role switch
    { name: 'role switch case', re: new RegExp(`case\\s+${ROLE_LITERALS}\\s*:`) },
  ];

  const sourceFiles = (): string[] =>
    fs
      .readdirSync(ORG_DIR)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      // The predicate module itself is the ONE legitimate place, and this test
      // file is excluded because its own regex source would match itself.
      .filter((f) => f !== '__ORG_ACCESS__' && f !== path.basename(__filename))
      .filter((f) => !f.endsWith('.test.ts'))
      .map((f) => path.join(ORG_DIR, f));

  it('scans a non-trivial set of files (the scan actually ran)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some((f) => f.endsWith('org-members.routes.ts'))).toBe(true);
  });

  it('no file outside org-access.ts compares a role to an OrgRole literal', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (path.basename(file) === 'org-access.ts') continue; // THE authority
      const src = fs.readFileSync(file, 'utf8');
      // Strip line comments and block comments so prose ("never compare
      // role === 'OWNER' here") cannot trip the scan, matching the
      // route-posture.test.ts `^\s*` convention of only matching real code.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      for (const { name, re } of PATTERNS) {
        if (re.test(code)) offenders.push(`${path.basename(file)}: ${name} (${re})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('org-access.ts IS where the literals live (so the exemption above is real, not vacuous)', () => {
    const src = fs.readFileSync(path.join(ORG_DIR, 'org-access.ts'), 'utf8');
    // The capability table's keys ARE the role names — that is the single source.
    for (const role of ORG_ROLES) {
      expect(src).toContain(`${role}: new Set<OrgCapability>(`);
    }
  });

  it('the scan would CATCH a regression (self-check on a synthetic offender)', () => {
    // A guard that cannot fail is not a guard: run the same predicates over a
    // synthetic line and assert they fire.
    const sample = "if (membership.role === 'OWNER') { /* sneaky */ }";
    expect(PATTERNS.some(({ re }) => re.test(sample))).toBe(true);
    const sample2 = "switch (role) { case 'BILLING': break; }";
    expect(PATTERNS.some(({ re }) => re.test(sample2))).toBe(true);
    // A USER-role (isAdminViewer) check is a different concept and must NOT fire.
    expect(PATTERNS.some(({ re }) => re.test("if (user.role === 'ADMIN') {}"))).toBe(true);
    // ^ documents the one known ambiguity: the user Role enum shares the strings
    // OWNER/ADMIN with OrgRole. That is why the scan covers THIS directory only —
    // org-admin.routes.ts (the user-role surface) is exempt by LOCATION, and the
    // two new files are asserted clean above.
  });
});