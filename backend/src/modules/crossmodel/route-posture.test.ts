/**
 * Route-posture tests for the single app-level `authenticate` guard.
 *
 * Mounts the REAL crossmodel route files in the exact app.ts order — open
 * routers → `app.use('/api/crossmodel', authenticate)` → authed routers — and
 * drives them over real HTTP (supertest is not a dependency; app.listen(0) +
 * fetch is hermetic). Controllers and the integration sub-routers are mocked
 * (every controller method answers 200 { ok: true }) so a test can distinguish
 * "reached the handler" from "the guard 401d"; middleware/auth, auth-cookie,
 * and validate run for real, with only utils/jwt + utils/logger mocked.
 *
 * What this pins (the refactor's invariants):
 *  - authed routes still 401 without a token (never weakened),
 *  - open/SSE endpoints (stream, stream/register, profile/stream, feedback,
 *    public share links, coding stream ?token=) stay reachable anonymously,
 *  - a deep authed request (/coding/*, behind all 8 authed routers) runs
 *    authenticate EXACTLY ONCE — one JWT verify, one cm_access Set-Cookie.
 *
 * Rate limiters (scoped to /stream and /upload in app.ts) are app-level
 * concerns and deliberately omitted; they don't affect auth posture.
 */

import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { authenticate } from '../../middleware/auth';
import { verifyAccessToken } from '../../utils/jwt';

// ── Mocks (factories must be self-contained — no outer-scope references) ─────
jest.mock('../../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));

// P3: platform.routes (mounted below) pulls config/database + error-handler +
// agent-auth → config/env, which calls process.exit(1) without env vars and
// kills the whole jest worker at import time. No test hits /platform endpoints
// over HTTP (only mount-order is asserted), so load-time stand-ins suffice.
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
// platform.routes also pulls middleware/redis-rate-limit-store → config/redis
// → config/env (same import-time exit); the store is never exercised here.
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../../middleware/agent-auth', () => ({
  __esModule: true,
  authenticatePlatform: (_req: any, _res: any, next: any) => next(),
  requireScope: () => (_req: any, _res: any, next: any) => next(),
  rejectAgentToken: (_req: any, _res: any, next: any) => next(),
  hashAgentToken: (t: string) => t,
  AGENT_TOKEN_PREFIX: 'dgt_',
  // zod v4 builds z.enum() EAGERLY at schema-construction (import) time —
  // platform.validation's z.enum(AGENT_TOKEN_SCOPES) throws on a mock that
  // omits the array (v3 tolerated it lazily). The REAL array lives in
  // agent-auth; mirror it so the mounted routes load.
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write',
    'schedules:write', 'code:run',
  ],
}));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('./crossmodel.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
// Client-error ingest (ticket d4e643a5) is a NAMED controller export that
// crossmodel-open.routes imports from its own module, so the Proxy above does
// not reach it. Same stand-in shape, both export forms — this suite pins AUTH
// POSTURE, and the real handler (logger/scan/throttle) is exercised end-to-end
// by client-errors/client-error.endpoint.test.ts.
jest.mock('./client-errors/client-error.controller', () => {
  const handler = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    __esModule: true,
    default: { report: handler },
    clientErrorController: { report: handler },
    // express requires a callable middleware; a no-op keeps the route loadable
    // (this suite pins auth posture, and the real 16 KB cap is exercised by
    // client-errors/client-error.endpoint.test.ts).
    clientErrorBodyParser: (_req: any, _res: any, next: any) => next(),
  };
});
jest.mock('./sharing.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./projects.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./canvas.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./children.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./documents.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./coding/coding.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./confirmations.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./coding/coding-preview.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
jest.mock('./upload.controller', () => ({
  uploadMiddleware: (_req: any, _res: any, next: any) => next(),
  processUpload: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));
// Generated files (agent document tools): the download twin lives on a
// pre-guard query-token router; list/delete + Bearer download behind the guard.
jest.mock('./generated-files.controller', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (_req: any, res: any) => res.status(200).json({ ok: true }) }),
}));
// Per-chat inbound webhooks (2026-08-23): named exports — the fire handler
// (open router) and the owner-only lifecycle handlers (authed router).
jest.mock('./webhook.controller', () => ({
  __esModule: true,
  fireWebhook: (_req: any, res: any) => res.status(200).json({ ok: true }),
  getChatWebhook: (_req: any, res: any) => res.status(200).json({ ok: true }),
  createChatWebhook: (_req: any, res: any) => res.status(200).json({ ok: true }),
  deleteChatWebhook: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

// Push registration (M1): the REAL routes + middleware run (that's the
// posture under test) but the DB-touching service layer is stubbed — same
// pattern as every controller mock above.
jest.mock('./push/push.service', () => ({
  __esModule: true,
  registerPushToken: jest.fn().mockResolvedValue(undefined),
  unregisterPushToken: jest.fn().mockResolvedValue(undefined),
  pushTransportsConfigured: jest.fn(() => ({ expo: true, apns: false, fcm: false })),
}));

// Content reports (M2-prep): same pattern — real routes/middleware, stubbed
// service (the DB layer is not under posture test).
jest.mock('./reports/reports.service', () => ({
  __esModule: true,
  createContentReport: jest.fn().mockResolvedValue({ id: 'r-stub' }),
  listContentReports: jest.fn().mockResolvedValue([]),
  resolveContentReport: jest.fn().mockResolvedValue({ resolved: true }),
  REPORT_REASONS: [
    'hate_speech', 'harassment', 'sexual_content', 'violence', 'self_harm',
    'dangerous_acts', 'misinformation', 'illegal', 'spam', 'other',
  ],
  REPORT_SURFACES: ['mobile', 'web'],
}));

// First-party visitor analytics (owner 2026-10-07): the OPEN beacon handler + the admin reads — handlers mocked
// (posture, not the service, is under test); the real routes / middleware run.
jest.mock('./visitors/visitor.controller', () => ({
  __esModule: true,
  postVisitEvents: (_req: any, res: any) => res.status(200).json({ ok: true }),
  getTrafficSources: (_req: any, res: any) => res.status(200).json({ ok: true }),
  getTrafficUsers: (_req: any, res: any) => res.status(200).json({ ok: true }),
  getTrafficFlow: (_req: any, res: any) => res.status(200).json({ ok: true }),
}));

// Integration sub-routers → empty Routers. Their PER-ROUTE authenticate is
// unchanged by this refactor (they live in the open router, before the guard),
// and importing the real ones would pull env-dependent services into the test.
jest.mock('./google/google-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./github/github-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./x/x-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./xero/xero-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./slack/slack-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./asana/asana-oauth.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./plaid/plaid.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./imessage/imessage.routes', () => ({ __esModule: true, default: require('express').Router() }));
jest.mock('./telegram/telegram.routes', () => ({ __esModule: true, default: require('express').Router() }));

import publicShareRoutes from './public-share.routes';
import codingPublicRoutes from './coding/coding-public.routes';
import generatedFilesPublicRoutes from './generated-files-public.routes';
import crossmodelOpenRoutes from './crossmodel-open.routes';
import modelEndpointsRoutes from './model-endpoints/model-endpoints.routes';
import crossmodelRoutes from './crossmodel.routes';
import childrenRoutes from './children.routes';
import projectsRoutes from './projects.routes';
import platformRoutes from './platform/platform.routes';
import sharingRoutes from './sharing.routes';
import documentsRoutes from './documents.routes';
import generatedFilesRoutes from './generated-files.routes';
import canvasRoutes from './canvas.routes';
import codingRoutes from './coding/coding.routes';
import { webhookAuthedRoutes } from './webhook.routes';
import { pushRoutes } from './push/push.routes';
import { reportsRoutes } from './reports/reports.routes';
import { visitorAdminRoutes } from './visitors/visitor.routes';

const mockedVerify = verifyAccessToken as jest.Mock;
const ADULT = { userId: 'u1', email: 'a@b.c', role: 'USER' };

/** Mirror of app.ts's /api/crossmodel mount order (the ordering contract). */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/crossmodel', publicShareRoutes);
  app.use('/api/crossmodel', codingPublicRoutes);
  app.use('/api/crossmodel', generatedFilesPublicRoutes); // query-token download twin — pre-guard
  app.use('/api/crossmodel', crossmodelOpenRoutes);
  app.use('/api/crossmodel/platform', platformRoutes); // P3 — self-authenticates (user JWT or scoped dgt_ token)
  app.use('/api/crossmodel', authenticate); // ── the single guard ──
  app.use('/api/crossmodel', modelEndpointsRoutes); // admin model registry (mounted like app.ts — the ghost-endpoint posture pins ride it)
  app.use('/api/crossmodel', crossmodelRoutes);
  app.use('/api/crossmodel', childrenRoutes);
  app.use('/api/crossmodel', projectsRoutes);
  app.use('/api/crossmodel', sharingRoutes);
  app.use('/api/crossmodel', documentsRoutes);
  app.use('/api/crossmodel', generatedFilesRoutes); // list/delete + Bearer download — post-guard
  app.use('/api/crossmodel', canvasRoutes);
  app.use('/api/crossmodel', codingRoutes);
  app.use('/api/crossmodel', webhookAuthedRoutes); // webhook token lifecycle — owner-only, behind the guard (the OPEN fire router rides inside crossmodelOpenRoutes)
  app.use('/api/crossmodel/push', pushRoutes); // mobile push registration — behind the guard (mirrors app.ts)
  app.use('/api/crossmodel/reports', reportsRoutes); // content reports (M2-prep) — behind the guard (mirrors app.ts)
  app.use('/api/crossmodel', visitorAdminRoutes); // visitor analytics admin reads — behind the guard (mirrors app.ts)
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp().listen(0, '127.0.0.1'); // explicit host: the fetch targets 127.0.0.1 (port-0 wildcard binds can collide across jest workers)
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedVerify.mockImplementation((token: string) => {
    if (token === 'good-token') return ADULT;
    if (token === 'child-token') return { ...ADULT, isChild: true };
    throw new Error('bad token');
  });
});

/** Count cm_access Set-Cookie headers on a real HTTP response. */
function cmAccessCookies(res: globalThis.Response): string[] {
  const getSetCookie = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie;
  return getSetCookie.call(res.headers).filter((c) => c.startsWith('cm_access='));
}

const bearer = { authorization: 'Bearer good-token' };

describe('app-level authenticate guard — authed posture preserved', () => {
  it('401s a no-token request to an authed route (GET /chats)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('401s an invalid Bearer token on an authed route', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
  });

  it('401s a no-token request to children management (GET /children)', async () => {
    const res = await fetch(`${base}/api/crossmodel/children`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('runs authenticate EXACTLY ONCE on a deep authed route (one verify, one cm_access cookie)', async () => {
    const res = await fetch(`${base}/api/crossmodel/coding/projects`, { headers: bearer });
    expect(res.status).toBe(200);
    // The deep route sits behind all 8 authed routers — pre-refactor this
    // verified the JWT 8 times. Now: exactly one verify, one sliding re-issue.
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
    expect(cmAccessCookies(res)).toHaveLength(1);
  });

  it('accepts the httpOnly cm_access cookie (no Bearer) on an authed route', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats`, {
      headers: { cookie: 'cm_access=good-token' },
    });
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(cmAccessCookies(res)).toHaveLength(1);
  });

  it('keeps rejectChild wired off the guard: a child token is 403d from the adult workspace', async () => {
    const res = await fetch(`${base}/api/crossmodel/projects`, {
      headers: { authorization: 'Bearer child-token' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  // Archive/restore (owner 2026-09-08): four authed POST routes — behind the
  // single guard (401 anonymous), reachable with a token (mocked handler 200).
  const ARCHIVE_ROUTES = [
    '/api/crossmodel/chats/123e4567-e89b-12d3-a456-426614174000/archive',
    '/api/crossmodel/chats/123e4567-e89b-12d3-a456-426614174000/restore',
    '/api/crossmodel/projects/123e4567-e89b-12d3-a456-426614174000/archive',
    '/api/crossmodel/projects/123e4567-e89b-12d3-a456-426614174000/restore',
  ];

  it('401s no-token requests to the archive/restore endpoints (authed posture)', async () => {
    for (const path of ARCHIVE_ROUTES) {
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect(res.status).toBe(401);
    }
  });

  it('routes authenticated archive/restore requests through to their handlers', async () => {
    for (const path of ARCHIVE_ROUTES) {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: bearer });
      expect(res.status).toBe(200); // reached the mocked controller — route exists behind the guard
    }
  });
});

describe('app-level authenticate guard — open posture preserved', () => {
  it('lets an anonymous request reach GET /stream (open SSE endpoint)', async () => {
    const res = await fetch(`${base}/api/crossmodel/stream`);
    expect(res.status).toBe(200); // reached the controller — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach POST /stream/register (SSE pre-registration)', async () => {
    const res = await fetch(`${base}/api/crossmodel/stream/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach GET /profile/stream (handler self-checks 401)', async () => {
    const res = await fetch(`${base}/api/crossmodel/profile/stream?message=hi`);
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach GET /session/:sessionId/state (guest resume, 2026-09-26 — anonymous-ONLY by design)', async () => {
    const res = await fetch(`${base}/api/crossmodel/session/f47ac10b-58cc-4372-a567-0e02b2c3d479/state`);
    expect(res.status).toBe(200); // reached the (proxied) controller — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  // Stream drops (2026-10-20): the GUEST reattach twin of /chats/:id/stream —
  // an anonymous EventSource, so it must stay in the OPEN router (the uuid in
  // the path is the credential, like /state); the handler 404s signed-in callers.
  it('lets an anonymous request reach GET /session/:sessionId/stream (guest reattach, 2026-10-20 — anonymous-ONLY by design)', async () => {
    const res = await fetch(`${base}/api/crossmodel/session/f47ac10b-58cc-4372-a567-0e02b2c3d479/stream`);
    expect(res.status).toBe(200); // reached the (proxied) controller — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach POST /feedback (validated, still open)', async () => {
    const res = await fetch(`${base}/api/crossmodel/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: '123e4567-e89b-12d3-a456-426614174000', type: 'thumbs_up' }),
    });
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach GET /shared/chat/:token (public share link)', async () => {
    const res = await fetch(`${base}/api/crossmodel/shared/chat/some-share-token`);
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  // Shared-chat generated images (generate_image tranche B, 2026-09-24): the
  // public page's figures fetch bytes from a token-scoped route on the SAME
  // no-auth router — a viewer without an account must reach it, and the
  // handler (not a guard) decides via the link + file↔chat binding.
  it('lets an anonymous request reach GET /shared/chat/:token/image/:fileId (shared-chat image bytes)', async () => {
    const res = await fetch(`${base}/api/crossmodel/shared/chat/some-share-token/image/f1`);
    expect(res.status).toBe(200); // reached the (mocked) handler — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('lets an anonymous request reach the coding SSE stream route (controller self-checks auth)', async () => {
    const res = await fetch(`${base}/api/crossmodel/coding/sessions/s1/stream`);
    // optionalAuthenticate passes anonymous through; the REAL controller 401s.
    // The 200 from the mocked controller proves the app-level guard never ran.
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('authenticates the coding SSE stream via ?token= (EventSource cannot set headers)', async () => {
    const res = await fetch(`${base}/api/crossmodel/coding/sessions/s1/stream?token=good-token`);
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
    // Sliding re-issue happens in optionalAuthenticate too — still one cookie.
    expect(cmAccessCookies(res)).toHaveLength(1);
  });
});

describe('generated files — posture (review of #345)', () => {
  it('lets an anonymous request reach the query-token download twin (handler self-checks 401)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/download`);
    // Reached the (mocked) handler — NOT a guard 401. The REAL handler 401s
    // anonymous callers itself (downloadGeneratedFile self-check).
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('authenticates the download twin via ?token= (chat markdown links cannot send headers)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/download?token=good-token`);
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it('403s a child token on the query-token download twin (rejectChild — no kid bypass of the adult workspace)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/download?token=child-token`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  it('401s a no-token request to the authed list route (GET /generated-files)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('403s a child token on the authed generated-files router (rejectChild)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files`, {
      headers: { authorization: 'Bearer child-token' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  // Inline IMAGE twin (generate_image, 2026-09-24): the transcript's <img src>
  // and Files thumbnails are cookie/query-token fetches — same pre-guard
  // posture as the download twin, and the same no-kid-bypass rule.
  it('lets an anonymous request reach the query-token INLINE twin (handler self-checks 401)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/inline`);
    expect(res.status).toBe(200); // reached the (mocked) handler — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('authenticates the inline twin via ?token= (an <img src> cannot send headers)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/inline?token=good-token`);
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it('403s a child token on the inline twin (rejectChild)', async () => {
    const res = await fetch(`${base}/api/crossmodel/generated-files/f1/inline?token=child-token`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });
});

describe('image generation — posture (owner 2026-09-24)', () => {
  // POST /images/generate is the REST mirror of the generate_image tool: behind
  // the single guard (401 anonymous), rejectChild per-route (403 kids), and
  // reachable with a token (mocked handler 200).
  it('401s a no-token POST /images/generate', async () => {
    const res = await fetch(`${base}/api/crossmodel/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a red fox in the snow' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('403s a child token on POST /images/generate (rejectChild)', async () => {
    const res = await fetch(`${base}/api/crossmodel/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer child-token' },
      body: JSON.stringify({ prompt: 'a red fox in the snow' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  it('routes an authenticated POST /images/generate through to the handler', async () => {
    const res = await fetch(`${base}/api/crossmodel/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ prompt: 'a red fox in the snow' }),
    });
    expect(res.status).toBe(200); // reached the mocked controller — route exists behind the guard
    expect(mockedVerify).toHaveBeenCalledTimes(1);
  });
});

describe('per-chat inbound webhooks — posture (2026-08-23)', () => {
  it('lets an anonymous request reach POST /webhooks/:chatId/fire (self-authenticates via the per-chat bearer token — no session JWT)', async () => {
    const res = await fetch(`${base}/api/crossmodel/webhooks/some-chat/fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200); // reached the (mocked) handler — NOT a guard 401
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('401s a no-token request to webhook token management (GET /chats/:id/webhook)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/some-chat/webhook`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('403s a child token on webhook token management (rejectChild — Digby Kids never mints an external wake into the adult pipeline)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/some-chat/webhook`, {
      headers: { authorization: 'Bearer child-token' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });
});

describe('mobile Bearer-on-SSE (M0 — roadmap §3.2 item 1)', () => {
  // The mobile client streams with expo/fetch, which CAN set request headers
  // (unlike EventSource) — so every SSE/adjacent open route must accept
  // `Authorization: Bearer` alongside the web's cm_access cookie / ?token=.
  // optionalAuthenticate checks the Bearer header FIRST (middleware/auth.ts);
  // these pin that contract per route so a future middleware reorder cannot
  // silently strand the mobile app. (The roadmap §3.2 "cookie-only" premise
  // was written 2026-09-24 before this was verified — Bearer has worked since
  // the middleware existed; these tests make it load-bearing.)
  const SSE_BEARER_ROUTES: Array<{ label: string; path: string; method?: string }> = [
    { label: 'unified chat run stream (GET /chats/:id/stream)', path: '/api/crossmodel/chats/c1/stream' },
    { label: 'query stream (GET /stream)', path: '/api/crossmodel/stream?message=hi&mode=single_thinking' },
    { label: 'stream pre-registration (POST /stream/register)', path: '/api/crossmodel/stream/register', method: 'POST' },
    { label: 'profile stream (GET /profile/stream)', path: '/api/crossmodel/profile/stream?message=hi' },
    { label: 'agent run attach (GET /agent/attach)', path: '/api/crossmodel/agent/attach?chatId=c1' },
    { label: 'upload (POST /upload)', path: '/api/crossmodel/upload', method: 'POST' },
  ];

  for (const route of SSE_BEARER_ROUTES) {
    it(`authenticates ${route.label} via Authorization: Bearer (no cookie, no query token)`, async () => {
      const res = await fetch(`${base}${route.path}`, {
        method: route.method ?? 'GET',
        headers: route.method === 'POST'
          ? { 'content-type': 'application/json', ...bearer }
          : bearer,
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status).toBe(200); // reached the (mocked) handler — NOT a guard 401
      expect(mockedVerify).toHaveBeenCalledWith('good-token');
      // Sliding re-issue fires on the Bearer path too — exactly one cookie.
      expect(cmAccessCookies(res)).toHaveLength(1);
    });
  }

  it('keeps ?token= working on the unified chat run stream (EventSource fallback)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/c1/stream?token=good-token`);
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it('keeps the cm_access cookie working on the unified chat run stream (web path)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/c1/stream`, {
      headers: { cookie: 'cm_access=good-token' },
    });
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it('lets an anonymous request reach the chat run stream (REAL handler self-checks 401)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/c1/stream`);
    // optionalAuthenticate passes anonymous through; the REAL streamChatRun
    // self-checks req.user?.id → 401 (crossmodel.controller.ts). The 200 from
    // the mocked controller proves the app-level guard never ran.
    expect(res.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('treats an INVALID Bearer on the chat run stream as anonymous (never a 500)', async () => {
    const res = await fetch(`${base}/api/crossmodel/chats/c1/stream`, {
      headers: { authorization: 'Bearer garbage' },
    });
    // optionalAuthenticate swallows the verify failure and continues anonymous
    // — the handler's own 401 is the response. Never a middleware crash.
    expect(res.status).toBe(200); // mocked handler; REAL one 401s
    expect(mockedVerify).toHaveBeenCalledWith('garbage');
  });
});

describe('mobile push registration — posture (M1, roadmap §3.2 item 2)', () => {
  // POST /api/crossmodel/push/register + DELETE /api/crossmodel/push/:token
  // live BEHIND the single guard (a device token is per-user); GET /status is
  // the client's transport-availability probe on the same authed router.
  it('401s a no-token POST /push/register', async () => {
    const res = await fetch(`${base}/api/crossmodel/push/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(40) }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('403s a child token on POST /push/register (rejectChild — Digby Kids never push)', async () => {
    const res = await fetch(`${base}/api/crossmodel/push/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer child-token' },
      body: JSON.stringify({ token: 'a'.repeat(40) }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  it('401s a no-token DELETE /push/:token', async () => {
    const res = await fetch(`${base}/api/crossmodel/push/some-token`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('routes an authenticated POST /push/register through to the handler', async () => {
    const res = await fetch(`${base}/api/crossmodel/push/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ token: 'a'.repeat(40), provider: 'expo', platform: 'ios' }),
    });
    // Reached the handler (mocked DB layer) — NOT a guard 401.
    expect(res.status).toBe(200);
  });
});

describe('content reports — posture (M2-prep, guidelines 1.2/1.4)', () => {
  // POST /api/crossmodel/reports (file) is any-authed-user behind the single
  // guard + rejectChild; GET / + POST /:id/review additionally admin-gated.
  it('401s a no-token POST /reports', async () => {
    const res = await fetch(`${base}/api/crossmodel/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'c1', messageId: 'm1', reason: 'spam' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('403s a child token on POST /reports (rejectChild)', async () => {
    const res = await fetch(`${base}/api/crossmodel/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer child-token' },
      body: JSON.stringify({ chatId: 'c1', messageId: 'm1', reason: 'spam' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CHILD_ACCOUNT_FORBIDDEN' });
  });

  it('403s a non-admin GET /reports (moderation queue is admin-only)', async () => {
    const res = await fetch(`${base}/api/crossmodel/reports`, { headers: bearer });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
  });

  it('routes an authenticated POST /reports through to the handler', async () => {
    const res = await fetch(`${base}/api/crossmodel/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ chatId: 'c1', messageId: 'm1', reason: 'spam' }),
    });
    // Reached the handler (mocked service layer) — NOT a guard 401.
    expect(res.status).toBe(201);
  });

  it('401s a no-token POST /reports/:id/review', async () => {
    const res = await fetch(`${base}/api/crossmodel/reports/r1/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewAction: 'ok' }),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * Static tripwire for the ordering contract in app.ts (adversarial-review
 * follow-up): the HTTP tests above MIRROR app.ts's mount order, so they cannot
 * catch a regression in app.ts itself — the guard deleted, duplicated, or
 * moved above an open router (the 2026-07-23 outage class in reverse). These
 * read the real sources and fail loudly if the contract is broken.
 */
describe('app.ts ordering contract — static tripwire', () => {
  const fs = require('fs');
  const path = require('path');
  const appSource: string = fs.readFileSync(path.resolve(__dirname, '../../app.ts'), 'utf8');

  const mountIndex = (needle: string): number => {
    const i = appSource.indexOf(needle);
    if (i === -1) throw new Error(`mount not found in app.ts: ${needle}`);
    return i;
  };

  it('mounts the single guard exactly once', () => {
    // Leg (b) phase 1: mounts go through mountApi, which places ONE stack at
    // each API prefix. The guard must still be declared exactly once in source
    // (it is then mounted once per prefix — correct, and still a single guard in
    // the chain for any given request). A raw app.use form would bypass the
    // prefix list, so it must not exist at all.
    const occurrences = appSource.split("mountApi(app, '', authenticate)").length - 1;
    expect(occurrences).toBe(1);
    expect(appSource).not.toContain("app.use('/api/crossmodel', authenticate)");
  });

  it('orders open routers before the guard and authed routers after it', () => {
    const guard = mountIndex("mountApi(app, '', authenticate)");
    for (const open of [
      "mountApi(app, '', publicShareRoutes)",
      "mountApi(app, '', codingPublicRoutes)",
      "mountApi(app, '', generatedFilesPublicRoutes)",
      "mountApi(app, '', crossmodelOpenRoutes)",
      "mountApi(app, '/platform', platformRoutes)",
    ]) {
      expect(mountIndex(open)).toBeLessThan(guard);
    }
    for (const authed of [
      "mountApi(app, '', crossmodelRoutes)",
      "mountApi(app, '', childrenRoutes)",
      "mountApi(app, '', projectsRoutes)",
      "mountApi(app, '', sharingRoutes)",
      "mountApi(app, '', documentsRoutes)",
      "mountApi(app, '', generatedFilesRoutes)",
      "mountApi(app, '', canvasRoutes)",
      "mountApi(app, '', codingRoutes)",
      "mountApi(app, '', fleetRoutes)",
      "mountApi(app, '', webhookAuthedRoutes)",
      "mountApi(app, '', visitorAdminRoutes)",
    ]) {
      expect(mountIndex(authed)).toBeGreaterThan(guard);
    }
  });

  it('no crossmodel route file re-introduces router.use(authenticate)', () => {
    const routeFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.routes.ts')) routeFiles.push(full);
      }
    };
    walk(__dirname);
    expect(routeFiles.length).toBeGreaterThan(10); // sanity: the scan ran
    for (const file of routeFiles) {
      const src: string = fs.readFileSync(file, 'utf8');
      // ^\s* anchors to real code — comments start with `//` or ` *`.
      expect(src).not.toMatch(/^\s*router\.use\(authenticate\)/m);
    }
  });

  it('open routers carry no bare router.use(middleware) that could end a fall-through request', () => {
    for (const file of [
      'public-share.routes.ts',
      'crossmodel-open.routes.ts',
      'coding/coding-public.routes.ts',
      'generated-files-public.routes.ts',
    ]) {
      const src: string = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // Prefix mounts (router.use('/google', sub)) are fine; bare middleware is not.
      expect(src).not.toMatch(/^\s*router\.use\((?!['"`])/m);
    }
  });
});

describe('supervisor OFF switch — admin settings posture (owner 2026-09-26)', () => {
  it('401s a no-token GET /admin/settings/supervisors (authed router, behind the guard)', async () => {
    const res = await fetch(`${base}/api/crossmodel/admin/settings/supervisors`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
  });

  it('routes an authenticated GET /admin/settings/supervisors and PUT /admin/settings/fleet_supervisor_enabled to their handlers (the handler owns the admin check)', async () => {
    const get = await fetch(`${base}/api/crossmodel/admin/settings/supervisors`, { headers: bearer });
    expect(get.status).toBe(200);
    const put = await fetch(`${base}/api/crossmodel/admin/settings/fleet_supervisor_enabled`, {
      method: 'PUT', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ value: '0' }),
    });
    expect(put.status).toBe(200);
  });

  it('401s a no-token PUT on the switch key (never weakened by the GET addition)', async () => {
    const put = await fetch(`${base}/api/crossmodel/admin/settings/project_supervisors_enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '0' }),
    });
    expect(put.status).toBe(401);
  });

  it('ghost endpoint designation (owner 2026-10-22): 401s a no-token GET/PUT — mounted behind the authed router, the handler owns the admin check', async () => {
    const get = await fetch(`${base}/api/crossmodel/admin/model-roles/ghost-endpoint`);
    expect(get.status).toBe(401);
    const put = await fetch(`${base}/api/crossmodel/admin/model-roles/ghost-endpoint`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: 'homelab:m' }),
    });
    expect(put.status).toBe(401);
    // an authed (non-admin) caller reaches the HANDLER, which 403s — never a router hole
    const authed = await fetch(`${base}/api/crossmodel/admin/model-roles/ghost-endpoint`, { headers: bearer });
    expect([200, 403]).toContain(authed.status);
  });
});

describe('first-party visitor analytics — posture (owner 2026-10-07)', () => {
  it('lets an ANONYMOUS visitor reach POST /visit-events (open router, no guard 401) — JSON and sendBeacon text/plain', async () => {
    const json = await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(200); // reached the (mocked) handler
    const beacon = await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{}' });
    expect(beacon.status).toBe(200);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('a signed-in visitor is identified on POST /visit-events (optionalAuthenticate — the stitching path)', async () => {
    const res = await fetch(`${base}/api/crossmodel/visit-events`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it.each(['sources', 'users', 'flow'])('401s a no-token GET /admin/traffic/%s (authed router, behind the guard)', async (p) => {
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/${p}`);
    expect(res.status).toBe(401);
  });

  it.each(['sources', 'users', 'flow'])('routes an authenticated GET /admin/traffic/%s to its handler (the handler owns the admin check)', async (p) => {
    const res = await fetch(`${base}/api/crossmodel/admin/traffic/${p}`, { headers: bearer });
    expect(res.status).toBe(200);
  });

  it('app.ts rate-limits /visit-events per client (hashed ip key) and globally', () => {
    const fs = require('fs');
    const path = require('path');
    const appSource: string = fs.readFileSync(path.resolve(__dirname, '../../app.ts'), 'utf8');
    expect(appSource).toContain("store: new RedisRateLimitStore('rl:visit:')");
    expect(appSource).toContain("store: new RedisRateLimitStore('rl:visitall:')");
    expect(appSource).toContain('keyGenerator: (req) => `c:${hashIp(clientIpForHash(req as any)) ?? \'noip\'}`');
    expect(appSource).toContain('mountApi(app, \'\', visitEventsClientRateLimit, visitEventsGlobalRateLimit);');
  });
});

/**
 * Client UI error capture (ticket d4e643a5, 2026-11-06). The endpoint MUST stay
 * reachable without a token: a crashing tab may be signed out, and a crash
 * inside the LOGIN FLOW has no credential to send at all. Moving this route
 * behind the app-level guard would silently make the feature a no-op for
 * exactly the failures that matter most, so the posture is pinned here beside
 * /visit-events rather than left to convention.
 */
describe('client error ingest — posture (ticket d4e643a5)', () => {
  it('lets an ANONYMOUS tab reach POST /client-error (open router, no guard 401)', async () => {
    const res = await fetch(`${base}/api/crossmodel/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'TypeError: anonymous crash', source: 'onerror' }),
    });
    expect(res.status).toBe(200); // reached the (mocked) handler, never the guard
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('a signed-in tab is identified on POST /client-error (optionalAuthenticate links the report)', async () => {
    const res = await fetch(`${base}/api/crossmodel/client-error`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'TypeError: signed-in crash', source: 'onerror' }),
    });
    expect(res.status).toBe(200);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
  });

  it('a body with no message is rejected by the schema BEFORE the handler (no empty rows in app_error_logs)', async () => {
    const res = await fetch(`${base}/api/crossmodel/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'onerror' }),
    });
    // This harness mounts NO error handler (it pins auth posture), so a zod
    // rejection surfaces as express's default 500 rather than the app's mapped
    // 400 (middleware/error-handler.ts:122). What it CAN prove is the thing
    // that matters here: the mocked handler never answered 200 — validation
    // runs BEFORE the ingest seam, so an empty message can never be written.
    // The real 400 is pinned end-to-end in client-errors/client-error.endpoint.test.ts.
    expect(res.status).not.toBe(200);
  });

  it('app.ts rate-limits /client-error per client (hashed ip key) and globally', () => {
    const fs = require('fs');
    const path = require('path');
    const appSource: string = fs.readFileSync(path.resolve(__dirname, '../../app.ts'), 'utf8');
    expect(appSource).toContain("store: new RedisRateLimitStore('rl:clienterr:')");
    expect(appSource).toContain("store: new RedisRateLimitStore('rl:clienterrall:')");
    expect(appSource).toContain('mountApi(app, \'\', clientErrorClientRateLimit, clientErrorGlobalRateLimit);');
  });
});
