/**
 * Visitor analytics HTTP handlers (owner 2026-10-07): the open beacon endpoint answers 204 (400 only for a malformed
 * body), the admin reads are ADMIN-only (403 otherwise, a child never), the flow validates its id, pagination
 * params pass through. Real Express over real HTTP (app.listen(0) + fetch, the route-posture idiom).
 */
const mockIngest = jest.fn();
const mockSources = jest.fn();
const mockUsers = jest.fn();
const mockFlow = jest.fn();
jest.mock('./visitor.service', () => ({
  __esModule: true,
  ingestVisitBatch: (...a: any[]) => mockIngest(...a),
  visitorAnalyticsDisabled: () => process.env.VISITOR_ANALYTICS_DISABLED === '1',
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}));
jest.mock('./visitor-analytics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./visitor-analytics.service'),
  trafficSources: (...a: any[]) => mockSources(...a),
  trafficUsers: (...a: any[]) => mockUsers(...a),
  trafficFlow: (...a: any[]) => mockFlow(...a),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { postVisitEvents, isTrafficAdmin } from './visitor.controller';
import { visitorAdminRoutes, visitEventsBodyParser } from './visitor.routes';

let server: Server;
let base: string;
let currentUser: any = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = currentUser; next(); });
  app.post('/api/crossmodel/visit-events', visitEventsBodyParser, postVisitEvents);
  app.use('/api/crossmodel', visitorAdminRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  jest.clearAllMocks();
  currentUser = null;
  delete process.env.VISITOR_ANALYTICS_DISABLED;
});

const ADMIN = { id: 'a', userId: 'a', email: 'ops@x.com', role: 'ADMIN' };
const OWNER = { id: 'o', userId: 'o', email: 'example-user@example.com', role: 'USER' };
const USER = { id: 'u', userId: 'u', email: 'u@x.com', role: 'USER' };

describe('POST /visit-events (open)', () => {
  it('204 on a stored batch — JSON body', async () => {
    mockIngest.mockResolvedValue({ status: 'stored', events: 1, visitorId: 'v' });
    const res = await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: 'v', events: [] }) });
    expect(res.status).toBe(204);
    expect(mockIngest.mock.calls[0][0].body).toEqual({ visitorId: 'v', events: [] });
  });

  it('accepts a sendBeacon text/plain body (handed over as a string)', async () => {
    mockIngest.mockResolvedValue({ status: 'stored', events: 0, visitorId: 'v' });
    const res = await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{"visitorId":"v","events":[]}' });
    expect(res.status).toBe(204);
    expect(mockIngest.mock.calls[0][0].body).toBe('{"visitorId":"v","events":[]}');
  });

  it('400 for a malformed body; 204 for every skip (bot / child) and on an unexpected failure', async () => {
    mockIngest.mockResolvedValueOnce({ status: 'invalid', error: 'bad' });
    expect((await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    mockIngest.mockResolvedValueOnce({ status: 'skipped', reason: 'child' });
    expect((await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(204);
    mockIngest.mockRejectedValueOnce(new Error('x'));
    expect((await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(204);
  });

  it('kill switch: 204 without touching the service', async () => {
    process.env.VISITOR_ANALYTICS_DISABLED = '1';
    expect((await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(204);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('admin traffic reads', () => {
  it('admin gate: role ADMIN or the owner account; never a regular user or a child', () => {
    expect(isTrafficAdmin(ADMIN)).toBe(true);
    expect(isTrafficAdmin(OWNER)).toBe(true);
    expect(isTrafficAdmin(USER)).toBe(false);
    expect(isTrafficAdmin({ ...ADMIN, isChild: true })).toBe(false);
    expect(isTrafficAdmin(undefined)).toBe(false);
  });

  it.each(['sources', 'users', 'flow?userId=11111111-1111-4111-8111-111111111111'])('403 %s for a non-admin', async (path) => {
    currentUser = USER;
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/${path}`);
    expect(res.status).toBe(403);
    expect(mockSources).not.toHaveBeenCalled();
    expect(mockUsers).not.toHaveBeenCalled();
    expect(mockFlow).not.toHaveBeenCalled();
  });

  it('sources: the date range is parsed server-side', async () => {
    currentUser = ADMIN;
    mockSources.mockResolvedValue({ channels: [] });
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/sources?from=2026-10-01&to=2026-10-03`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { channels: [] } });
    const arg = mockSources.mock.calls[0][0];
    expect(arg.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(arg.to.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('users: server-side pagination / sort / search params pass through', async () => {
    currentUser = OWNER;
    mockUsers.mockResolvedValue({ rows: [], total: 0, page: 3, pageSize: 50, sort: 'costAll', dir: 'asc' });
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/users?q=ads&sort=costAll&dir=asc&page=3&pageSize=50&kind=users&channel=google_ads`);
    expect(res.status).toBe(200);
    expect(mockUsers).toHaveBeenCalledWith({ q: 'ads', sort: 'costAll', dir: 'asc', page: 3, pageSize: 50, kind: 'users', channel: 'google_ads' });
  });

  it('flow: 400 without a uuid, 404 for null (missing or a Digby Kids account), 200 otherwise', async () => {
    currentUser = ADMIN;
    expect((await fetch(`${base}/api/crossmodel/admin/traffic/flow`)).status).toBe(400);
    expect((await fetch(`${base}/api/crossmodel/admin/traffic/flow?userId=not-a-uuid`)).status).toBe(400);
    mockFlow.mockResolvedValueOnce(null);
    expect((await fetch(`${base}/api/crossmodel/admin/traffic/flow?userId=11111111-1111-4111-8111-111111111111`)).status).toBe(404);
    mockFlow.mockResolvedValueOnce({ items: [] });
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/flow?visitorId=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`);
    expect(res.status).toBe(200);
    expect(mockFlow).toHaveBeenLastCalledWith({ visitorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  });

  it('500 on a read failure (no stack to the client)', async () => {
    currentUser = ADMIN;
    mockSources.mockRejectedValue(new Error('db'));
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/sources`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load traffic sources' });
  });
});
