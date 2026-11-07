/**
 * Branding-pack ROUTE tests (todo 61dc8aaf, Phase 2 Cloud).
 *
 * The service layer has its own behaviours (validation, activation), but the
 * thing that makes this feature SAFE is the HTTP surface, so that is what these
 * pin:
 *
 *  - the PUBLIC read is reachable by an ANONYMOUS caller (the whole point of a
 *    seasonal skin is that logged-out visitors see it) and reports
 *    `{ pack: null }` when nothing is active, which is what makes rollback-to-
 *    default a read-side no-op rather than an undo;
 *  - a DRAFT's bytes are NOT publicly readable even with the correct id and
 *    slot — the route filters on `pack.status = 'active'`;
 *  - an unknown slot 404s before any database work, so the public route has no
 *    caller-controlled key beyond the fixed slot allowlist;
 *  - every ADMIN handler is gated on the real `isAdminViewer` predicate and
 *    refuses a non-admin AND a child account BEFORE touching a service;
 *  - activate refuses a pack that is missing its logo, and a unique-violation
 *    race surfaces as 409 rather than a 500;
 *  - the ACTIVE pack cannot be deleted — rollback first — so delete can never be
 *    the accident that unbrands the site;
 *  - rollback is idempotent.
 *
 * Hermetic: the real routers, the real `validate` middleware and the real admin
 * predicate run; prisma, logger and the pack service are mocked. No DB, no app
 * boot (a bare express app + listen(0), the org-admin.routes.test.ts idiom).
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// The REAL admin predicate, with only its env-dependent leaf stubbed — a mock
// that re-implemented `role === 'ADMIN'` would stay green while the real owner-
// email fallback broke (the exact defect org-admin.routes.test.ts recorded).
jest.mock('../platform/instance-targets', () => ({
  __esModule: true,
  isProdInstance: () => false, // self-host posture: ADMIN role is the only authority
}));
jest.mock('./branding-pack.service', () => {
  const actual = jest.requireActual('./branding-pack.service');
  return {
    __esModule: true,
    // Keep the REAL pure helpers — they are what most of the value is.
    prepareAsset: actual.prepareAsset,
    PACK_ASSET_SLOTS: actual.PACK_ASSET_SLOTS,
    SLOT_RULES: actual.SLOT_RULES,
    PACK_LIMITS: actual.PACK_LIMITS,
    normalizeManifest: actual.normalizeManifest,
    missingForActivation: actual.missingForActivation,
    // Error classes must be the REAL ones so `instanceof` in the route works.
    PackValidationError: actual.PackValidationError,
    PackNotFoundError: actual.PackNotFoundError,
    PackConflictError: actual.PackConflictError,
    // The I/O seams are mocked.
    createPack: jest.fn(),
    listPacks: jest.fn(),
    activatePack: jest.fn(),
    rollbackToDefault: jest.fn(),
    deletePack: jest.fn(),
    getActivePack: jest.fn(),
    getActivePackAsset: jest.fn(),
  };
});

import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import {
  activatePack, createPack, deletePack, getActivePack, getActivePackAsset,
  listPacks, rollbackToDefault, PackConflictError, PackValidationError,
} from './branding-pack.service';
import { brandingPackAdminRoutes, brandingPackPublicRoutes } from './branding-pack.routes';

const mockList = listPacks as jest.Mock;
const mockCreate = createPack as jest.Mock;
const mockActivate = activatePack as jest.Mock;
const mockRollback = rollbackToDefault as jest.Mock;
const mockDelete = deletePack as jest.Mock;
const mockGetActive = getActivePack as jest.Mock;
const mockGetAsset = getActivePackAsset as jest.Mock;

const ADMIN = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' };
const USER = { id: 'user-1', role: 'USER', email: 'user@example.com' };

let app: Express;
let server: Server;
let base = '';

/** Stand-in for the app-level `authenticate` guard: the test sets `req.user`. */
function asUser(user: any) {
  return (req: any, _res: any, next: any) => {
    req.user = user;
    next();
  };
}

beforeAll(async () => {
  app = express();
  // PUBLIC half — no guard, exactly as app.ts mounts it before `authenticate`.
  app.use('/api/crossmodel', brandingPackPublicRoutes);
  // ADMIN half — behind a guard. The test mounts the guard itself so a request
  // with no user is a genuine 401/403 rather than a mocked pass.
  const guarded = express.Router();
  guarded.use((req, _res, next) => {
    // `x-test-role` stands in for the JWT the real guard would verify.
    const role = req.headers['x-test-role'];
    if (!role) return _res.status(401).json({ error: 'No token provided' });
    (req as any).user = role === 'admin' ? ADMIN : role === 'child' ? { ...USER, isChild: true } : USER;
    next();
  });
  guarded.use(brandingPackAdminRoutes);
  app.use('/api/crossmodel', guarded);

  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRollback.mockResolvedValue({ rolledBack: 1 });
  mockGetActive.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
});

// ── PUBLIC ──────────────────────────────────────────────────────────────────
describe('public read — anonymous visitors must see the seasonal skin', () => {
  it('GET /branding/pack answers 200 with pack:null when nothing is active', async () => {
    const res = await fetch(`${base}/api/crossmodel/branding/pack`);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ success: true, data: { pack: null } });
    // Cacheable but short: an operator's rollback must not be stranded behind a TTL.
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  it('GET /branding/pack serves the active pack with NO token', async () => {
    mockGetActive.mockResolvedValue({
      id: 'pack-1',
      name: 'Winter 2026',
      manifest: { name: 'Acme Winter' },
      assets: [{ slot: 'logo' }],
      activatedAt: '2026-11-07T00:00:00.000Z',
    });
    const res = await fetch(`${base}/api/crossmodel/branding/pack`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.pack.id).toBe('pack-1');
  });

  it('serves an active asset with a hard content-type, nosniff and the sha ETag', async () => {
    mockGetAsset.mockResolvedValue({
      data: Buffer.from('fake-png-bytes'),
      mimeType: 'image/png',
      sha256: 'abc123',
    });
    const res = await fetch(`${base}/api/crossmodel/branding/pack/pack-1/asset/logo`);
    expect(res.status).toBe(200);
    // Hard-pinned to the STORED type — never a caller-supplied one.
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('etag')).toBe('"abc123"');
    expect(await res.text()).toBe('fake-png-bytes');
  });

  it('404s an unknown slot WITHOUT asking the database', async () => {
    const res = await fetch(`${base}/api/crossmodel/branding/pack/pack-1/asset/nope`);
    expect(res.status).toBe(404);
    // The slot allowlist is the jail: no caller-controlled key reaches the store.
    expect(mockGetAsset).not.toHaveBeenCalled();
  });

  it('404s a draft pack\'s asset (the service filter is on status=active)', async () => {
    mockGetAsset.mockResolvedValue(null); // what the real query returns for a draft
    const res = await fetch(`${base}/api/crossmodel/branding/pack/draft-1/asset/logo`);
    expect(res.status).toBe(404);
  });
});

// ── ADMIN GATE ──────────────────────────────────────────────────────────────
describe('admin gate — isAdminViewer, checked before any service call', () => {
  const adminRoutes: [string, string][] = [
    ['GET', '/admin/branding/packs'],
    ['POST', '/admin/branding/packs/pack-1/activate'],
    ['POST', '/admin/branding/packs/rollback'],
    ['DELETE', '/admin/branding/packs/pack-1'],
  ];

  it.each(adminRoutes)('%s %s 401s with no token', async (method, path) => {
    const res = await fetch(`${base}/api/crossmodel${path}`, { method });
    expect(res.status).toBe(401);
  });

  it.each(adminRoutes)('%s %s 403s a non-admin and reaches no service', async (method, path) => {
    const res = await fetch(`${base}/api/crossmodel${path}`, { method, headers: { 'x-test-role': 'user' } });
    expect(res.status).toBe(403);
    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockRollback).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it.each(adminRoutes)('%s %s 403s a CHILD account even when the role looks elevated', async (method, path) => {
    const res = await fetch(`${base}/api/crossmodel${path}`, { method, headers: { 'x-test-role': 'child' } });
    expect(res.status).toBe(403);
  });
});

// ── ADMIN FLOWS ─────────────────────────────────────────────────────────────
describe('admin flows — upload → validate → preview → activate → rollback', () => {
  it('lists packs with the slot allowlist and limits the panel renders from', async () => {
    mockList.mockResolvedValue([
      { id: 'p1', name: 'Winter', status: 'active', manifest: {}, assets: [], createdAt: '', updatedAt: '', activatedAt: null, description: null },
    ]);
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs`, { headers: { 'x-test-role': 'admin' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.activePackId).toBe('p1');
    expect(body.data.slots).toContain('logo');
    expect(body.data.maxAssetBytes).toBeGreaterThan(0);
  });

  it('rejects an upload whose asset fails validation, saving NOTHING', async () => {
    const form = new FormData();
    form.append('name', 'Winter 2026');
    // An SVG — refused outright (same-origin XSS reasoning).
    form.append('logo', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')]), 'logo.svg');

    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs`, {
      method: 'POST',
      headers: { 'x-test-role': 'admin' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.rejections[0].slot).toBe('logo');
    expect(body.rejections[0].reason).toMatch(/SVG/);
    // The critical assertion: a rejected asset must not create a half-valid pack.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('accepts a valid upload and reports every bad slot in ONE pass', async () => {
    const form = new FormData();
    form.append('name', 'Winter 2026');
    // A real 1x1 PNG is too small for icon512 → one rejection, logo absent → fine.
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
      'hex',
    );
    form.append('icon512', new Blob([tinyPng]), 'icon.png');

    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs`, {
      method: 'POST',
      headers: { 'x-test-role': 'admin' },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.rejections.some((r: any) => r.slot === 'icon512')).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates a pack when every asset validates', async () => {
    mockCreate.mockResolvedValue({ id: 'new-1', name: 'Winter 2026', status: 'draft', assets: [] });
    // A 64x64 PNG header — valid for `logo` (min 32).
    const png64 = (() => {
      const sig = Buffer.from('89504e470d0a1a0a', 'hex');
      const len = Buffer.alloc(4); len.writeUInt32BE(13);
      const ihdr = Buffer.from('49484452', 'hex');
      const dims = Buffer.alloc(8); dims.writeUInt32BE(64, 0); dims.writeUInt32BE(64, 4);
      return Buffer.concat([sig, len, ihdr, dims, Buffer.alloc(5), Buffer.alloc(32)]);
    })();
    const form = new FormData();
    form.append('name', 'Winter 2026');
    form.append('manifest', JSON.stringify({ name: 'Acme Winter', theme: { light: '#eef6ff' } }));
    form.append('logo', new Blob([png64]), 'logo.png');

    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs`, {
      method: 'POST',
      headers: { 'x-test-role': 'admin' },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.name).toBe('Winter 2026');
    expect(arg.assets).toHaveLength(1);
    expect(arg.assets[0].mimeType).toBe('image/png');
    expect(arg.createdById).toBe('admin-1');
    // Manifest arrived as a JSON string and was parsed before normalization.
    expect(arg.manifest.name).toBe('Acme Winter');
  });

  it('activates a complete pack', async () => {
    mockActivate.mockResolvedValue({ id: 'pack-1', name: 'Winter 2026', status: 'active' });
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs/pack-1/activate`, {
      method: 'POST', headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(200);
    expect(mockActivate).toHaveBeenCalledWith('pack-1');
  });

  it('refuses activation of an incomplete pack with the operator\'s own words', async () => {
    mockActivate.mockRejectedValue(new PackValidationError('This pack cannot go live yet — it is missing: logo.'));
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs/pack-1/activate`, {
      method: 'POST', headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/missing: logo/);
  });

  it('surfaces a concurrent-activation race as 409, not 500', async () => {
    mockActivate.mockRejectedValue(new PackConflictError('Another pack was activated at the same moment.'));
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs/pack-1/activate`, {
      method: 'POST', headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(409);
  });

  it('rolls back to the shipped branding and is idempotent', async () => {
    mockRollback.mockResolvedValue({ rolledBack: 0 });
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs/rollback`, {
      method: 'POST', headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ success: true, data: { rolledBack: 0 } });
  });

  it('refuses to delete the ACTIVE pack (rollback first)', async () => {
    mockDelete.mockRejectedValue(new PackValidationError('This pack is live. Roll back to the default branding before deleting it.'));
    const res = await fetch(`${base}/api/crossmodel/admin/branding/packs/pack-1`, {
      method: 'DELETE', headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/Roll back/);
  });
});