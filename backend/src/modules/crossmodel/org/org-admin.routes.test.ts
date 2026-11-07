/**
 * Org-admin ROUTE tests (Phase 2 Cloud leg 1 items 2 + 4).
 *
 * The gap this closes is NOT in the service layer — setOrgSuspension exists and
 * org-suspension.test.ts covers it, and org-quota.service has refused sends from
 * a suspended org since the leg-1 migration. The gap was that nothing an
 * OPERATOR can call ever reached it: a kill switch with a thrower but no handle.
 * By the same token `organizations.dailyMessageLimit` was read by the quota
 * guard and written by nothing, so the free tier's limit could never be decided.
 *
 * So these tests pin the HTTP surface, which is the thing that was missing:
 *  - the routes are REGISTERED at the documented paths (not just declared);
 *  - a non-admin is refused with 403 BEFORE any service call runs (the gate is
 *    the first thing the handler does, so an unauthorised operator cannot even
 *    probe which org ids exist);
 *  - a child account is refused even though isAdminViewer would otherwise
 *    apply to its parent's session;
 *  - an admin's request reaches the service with the parsed body (boolean
 *    suspended, nullish reason, nullable limit);
 *  - the route's error path propagates the service's 404/400 rather than
 *    swallowing it into a 200.
 *
 * Hermetic: the real express router and the real `validate` middleware run;
 * prisma, logger, the admin predicate and the org service are mocked. No DB, no
 * app boot (a bare express app + listen(0), the route-posture.test.ts idiom).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    organization: { findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// The REAL admin predicate (review finding, 2026-11-06): this used to be a
// jest.mock that re-implemented the check as `role === 'ADMIN'` only. That made
// the gate test unable to catch a regression in the thing it guards — the real
// isAdminViewer also honours the owner-email fallback on production, and a copy
// that omits it would stay green while the owner got a 403 in prod.
// Only the module's env-dependent dependency is stubbed; the predicate is real.
jest.mock('../platform/instance-targets', () => ({
  __esModule: true,
  isProdInstance: () => false, // self-host posture: ADMIN role is the only authority
}));
jest.mock('./org.service', () => ({
  __esModule: true,
  setOrgSuspension: jest.fn(),
  setOrgDailyLimit: jest.fn(),
}));

import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import prisma from '../../../config/database';
import { setOrgSuspension, setOrgDailyLimit } from './org.service';
import { orgAdminRoutes } from './org-admin.routes';

const db = prisma as unknown as { organization: { findMany: jest.Mock } };
const suspend = setOrgSuspension as jest.Mock;
const setLimit = setOrgDailyLimit as jest.Mock;

const ORG = {
  id: 'org-1',
  slug: 'acme',
  suspended: true,
  suspendedReason: 'spam',
  dailyMessageLimit: 50,
};

/** Stand-in for the app-level guard: injects req.user from the x-test-user header. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as any).user = JSON.parse(raw);
    next();
  });
  app.use(orgAdminRoutes);
  app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  db.organization.findMany.mockResolvedValue([ORG]);
  suspend.mockResolvedValue(ORG);
  setLimit.mockResolvedValue({ ...ORG, dailyMessageLimit: 50 });
});

const asUser = (u: object) => ({ 'content-type': 'application/json', 'x-test-user': JSON.stringify(u) });
const ADMIN = { id: 'admin-1', role: 'ADMIN', email: 'admin@digby.ai' };

describe('route registration', () => {
  it('registers GET /admin/orgs, PUT /admin/orgs/:orgId/suspension and .../quota', () => {
    // A post-404 would prove the route file was mounted but the path was wrong,
    // so assert against the real stack rather than the source text.
    const paths = (orgAdminRoutes as any).stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'get /admin/orgs',
        'put /admin/orgs/:orgId/suspension',
        'put /admin/orgs/:orgId/quota',
      ]),
    );
  });
});

describe('admin gate — the control must not be reachable by a normal account', () => {
  it('403s GET /admin/orgs for a non-admin and never queries', async () => {
    const res = await fetch(`${base}/admin/orgs`, { headers: asUser({ id: 'u1', role: 'USER' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: admin access required' });
    expect(db.organization.findMany).not.toHaveBeenCalled();
  });

  it('403s suspension for a non-admin and never calls the service', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/suspension`, {
      method: 'PUT',
      headers: asUser({ id: 'u1', role: 'USER' }),
      body: JSON.stringify({ suspended: true, reason: 'spam' }),
    });
    expect(res.status).toBe(403);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('403s quota for a non-admin and never calls the service', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/quota`, {
      method: 'PUT',
      headers: asUser({ id: 'u1', role: 'USER' }),
      body: JSON.stringify({ dailyMessageLimit: 10 }),
    });
    expect(res.status).toBe(403);
    expect(setLimit).not.toHaveBeenCalled();
  });

  it('403s an ADMIN-role CHILD account (Digby Kids is not an operator)', async () => {
    const res = await fetch(`${base}/admin/orgs`, {
      headers: asUser({ id: 'kid-1', role: 'ADMIN', isChild: true }),
    });
    expect(res.status).toBe(403);
    expect(db.organization.findMany).not.toHaveBeenCalled();
  });

  it('403s a request with no user at all', async () => {
    const res = await fetch(`${base}/admin/orgs`);
    expect(res.status).toBe(403);
  });
});

describe('admin operations reach the service', () => {
  it('lists orgs with a case-insensitive q over name/slug', async () => {
    const res = await fetch(`${base}/admin/orgs?q=acme&limit=10`, { headers: asUser(ADMIN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number; orgs: Array<{ id: string }> } };
    expect(body.data.count).toBe(1);
    expect(body.data.orgs[0].id).toBe('org-1');
    const args = db.organization.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.where.OR).toEqual([
      { name: { contains: 'acme', mode: 'insensitive' } },
      { slug: { contains: 'acme', mode: 'insensitive' } },
    ]);
  });

  it('suspends an org, passing the parsed boolean + reason through', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/suspension`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ suspended: true, reason: 'spam' }),
    });
    expect(res.status).toBe(200);
    expect(suspend).toHaveBeenCalledWith('org-1', true, 'spam');
    expect(((await res.json()) as { data: { org: { suspended: boolean } } }).data.org.suspended).toBe(true);
  });

  it('reinstates an org (suspended:false, reason omitted becomes null)', async () => {
    suspend.mockResolvedValue({ ...ORG, suspended: false, suspendedReason: null });
    const res = await fetch(`${base}/admin/orgs/org-1/suspension`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ suspended: false }),
    });
    expect(res.status).toBe(200);
    expect(suspend).toHaveBeenCalledWith('org-1', false, null);
  });

  it('sets a numeric daily limit', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/quota`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ dailyMessageLimit: 50 }),
    });
    expect(res.status).toBe(200);
    expect(setLimit).toHaveBeenCalledWith('org-1', 50);
  });

  it('accepts null to restore UNLIMITED (the self-host posture)', async () => {
    setLimit.mockResolvedValue({ ...ORG, dailyMessageLimit: null });
    const res = await fetch(`${base}/admin/orgs/org-1/quota`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ dailyMessageLimit: null }),
    });
    expect(res.status).toBe(200);
    expect(setLimit).toHaveBeenCalledWith('org-1', null);
  });

  it('accepts 0 as a hard stop, distinct from null', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/quota`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ dailyMessageLimit: 0 }),
    });
    expect(res.status).toBe(200);
    expect(setLimit).toHaveBeenCalledWith('org-1', 0);
  });
});

describe('validation and error propagation', () => {
  it('rejects a non-boolean suspended flag before the service runs', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/suspension`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ suspended: 'yes', reason: 'spam' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('rejects a missing dailyMessageLimit (no silent "unlimited" on a typo)', async () => {
    const res = await fetch(`${base}/admin/orgs/org-1/quota`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setLimit).not.toHaveBeenCalled();
  });

  it('propagates the service 404 for an unknown org rather than claiming success', async () => {
    const err: any = new Error('Workspace not found');
    err.statusCode = 404;
    suspend.mockRejectedValue(err);
    const res = await fetch(`${base}/admin/orgs/nope/suspension`, {
      method: 'PUT',
      headers: asUser(ADMIN),
      body: JSON.stringify({ suspended: true, reason: 'spam' }),
    });
    expect(res.status).toBe(404);
  });
});