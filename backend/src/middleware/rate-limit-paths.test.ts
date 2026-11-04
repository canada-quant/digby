/**
 * middleware/rate-limit-paths.ts — the path matchers + client key the app.ts
 * limiters use (stream drops review, 2026-10-20). Pins, over a REAL express
 * app (port 0 + fetch, express-rate-limit with its MemoryStore, `trust proxy 1`
 * like app.ts) so the router's own non-strict / case-insensitive matching is
 * what is exercised:
 *   1. the guest reattach limiter COUNTS /session/<id>/stream/ and
 *      /SESSION/<id>/STREAM — both reach the handler, so neither may skip it;
 *   2. it keys per CLIENT (the hops-anchored X-Forwarded-For entry, hashed):
 *      two guests behind the same ALB node have separate buckets, so one cannot
 *      drain the other's reconnects;
 *   3. the /stream and /upload limiters count the trailing-slash / case forms
 *      too; RATE_LIMIT_PATH_NORMALIZE_DISABLED=1 restores the exact match;
 *   4. app.ts wires exactly these functions (a static tripwire — the HTTP
 *      tests above build their own limiters).
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// visitor.service (clientIpForHash) imports prisma → config/env, which exits a keyless test env at import.
jest.mock('../config/database', () => ({ __esModule: true, default: {} }));

import {
  GUEST_STREAM_ATTACH_PATH_RE, STREAM_LIMIT_PATH_RE, UPLOAD_LIMIT_PATH_RE,
  guestStreamAttachLimiterKey, guestStreamAttachLimiterSkip, hashedClientKey, streamLimiterSkip, uploadLimiterSkip,
} from './rate-limit-paths';

const SID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const ENV = ['QUOTA_TRUSTED_PROXY_HOPS', 'RATE_LIMIT_PATH_NORMALIZE_DISABLED'];

beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterAll(() => { for (const k of ENV) delete process.env[k]; });

describe('the matchers accept exactly what the router routes', () => {
  it('guest reattach: trailing slash and any case; never another route', () => {
    for (const p of [`/session/${SID}/stream`, `/session/${SID}/stream/`, `/SESSION/${SID}/STREAM`, `/Session/${SID}/Stream/`]) {
      expect(GUEST_STREAM_ATTACH_PATH_RE.test(p)).toBe(true);
      expect(guestStreamAttachLimiterSkip({ path: p })).toBe(false);
    }
    for (const p of [`/session/${SID}/state`, `/session/${SID}/stream/x`, '/session//stream', '/stream', `/sessions/${SID}/stream`]) {
      expect(guestStreamAttachLimiterSkip({ path: p })).toBe(true);
    }
  });

  it('/stream and /upload: trailing slash and any case; /stream/register is not /stream', () => {
    for (const p of ['/stream', '/stream/', '/STREAM', '/Stream/']) expect(STREAM_LIMIT_PATH_RE.test(p)).toBe(true);
    for (const p of ['/upload', '/upload/', '/UPLOAD']) expect(UPLOAD_LIMIT_PATH_RE.test(p)).toBe(true);
    expect(streamLimiterSkip({ path: '/stream/register' })).toBe(true);
    expect(uploadLimiterSkip({ path: '/upload/x' })).toBe(true);
  });

  it('RATE_LIMIT_PATH_NORMALIZE_DISABLED=1: /stream and /upload skip on the exact path again', () => {
    process.env.RATE_LIMIT_PATH_NORMALIZE_DISABLED = '1';
    expect(streamLimiterSkip({ path: '/stream' })).toBe(false);
    expect(streamLimiterSkip({ path: '/stream/' })).toBe(true);
    expect(uploadLimiterSkip({ path: '/upload' })).toBe(false);
    expect(uploadLimiterSkip({ path: '/UPLOAD' })).toBe(true);
    // The guest reattach matcher is new with its endpoint — never switched.
    expect(guestStreamAttachLimiterSkip({ path: `/session/${SID}/stream/` })).toBe(false);
  });
});

describe('the client key', () => {
  it('is the hashed hops-anchored client ip — two clients behind one ALB node differ; never the raw ip', () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    const a = guestStreamAttachLimiterKey({ ip: '10.0.0.4', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.4' } });
    const b = guestStreamAttachLimiterKey({ ip: '10.0.0.4', headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.4' } });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^c:[0-9a-f]{32}$/);
    expect(a).not.toContain('203.0.113.9');
    // A forged hop PREPENDED by the client cannot move the anchored entry.
    expect(guestStreamAttachLimiterKey({ ip: '10.0.0.4', headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.4' } })).toBe(a);
    expect(hashedClientKey({})).toBeNull();
    expect(guestStreamAttachLimiterKey({})).toBe('c:noip');
  });
});

describe('over a real express app', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', 1); // as app.ts — req.ip is then the LAST hop (the ALB node in prod)
    app.use('/api/crossmodel', rateLimit({
      windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false,
      keyGenerator: (req) => guestStreamAttachLimiterKey(req as any),
      skip: guestStreamAttachLimiterSkip,
    }));
    app.use('/api/crossmodel', rateLimit({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false, skip: streamLimiterSkip }));
    const router = express.Router();
    router.get('/session/:sessionId/stream', (_req, res) => { res.json({ ok: true }); });
    router.get('/stream', (_req, res) => { res.json({ ok: true }); });
    app.use('/api/crossmodel', router);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/crossmodel`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const get = (path: string, xff: string) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': xff } }).then((r) => r.status);

  it('the trailing-slash and upper-case reattach forms reach the handler AND are counted', async () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    const xff = '192.0.2.10, 10.0.0.4';
    expect(await get(`/session/${SID}/stream/`, xff)).toBe(200);
    expect(await get(`/SESSION/${SID}/STREAM`, xff)).toBe(200);
    expect(await get(`/session/${SID}/stream`, xff)).toBe(429);
    expect(await get(`/Session/${SID}/Stream/`, xff)).toBe(429);
  });

  it('two guests behind the same ALB node have separate buckets — one draining its own never blocks the other', async () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    const alb = '10.0.0.3';
    const a = `203.0.113.20, ${alb}`;
    const b = `198.51.100.30, ${alb}`;
    for (let i = 0; i < 2; i++) expect(await get(`/session/${SID}/stream`, a)).toBe(200);
    expect(await get(`/session/${SID}/stream`, a)).toBe(429);
    expect(await get(`/session/${SID}/stream`, b)).toBe(200);
  });

  it('the /stream limiter counts /stream/ and /STREAM', async () => {
    const xff = '192.0.2.99';
    expect(await get('/stream/', xff)).toBe(200);
    expect(await get('/STREAM', xff)).toBe(200);
    expect(await get('/stream', xff)).toBe(429);
  });
});

describe('app.ts wires these matchers — static tripwire', () => {
  const fs = require('fs');
  const path = require('path');
  const appSource: string = fs.readFileSync(path.resolve(__dirname, '../app.ts'), 'utf8');

  it('the /stream, /upload and guest reattach limiters skip through the shared matchers; the reattach keys per client', () => {
    expect(appSource).toContain('skip: streamLimiterSkip,');
    expect(appSource).toContain('skip: uploadLimiterSkip,');
    expect(appSource.split('skip: guestStreamAttachLimiterSkip,').length - 1).toBe(2); // per-client + global
    expect(appSource).toContain('keyGenerator: (req) => guestStreamAttachLimiterKey(req as any),');
    expect(appSource).toContain("app.use('/api/crossmodel', guestStreamAttachClientRateLimit, guestStreamAttachGlobalRateLimit);");
    expect(appSource).not.toMatch(/req\.path !== '\/(stream|upload)'/);
  });
});
